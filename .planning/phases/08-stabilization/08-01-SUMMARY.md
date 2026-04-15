---
phase: 08-stabilization
plan: "01"
subsystem: test-infrastructure
tags: [tests, vitest, raf-mock, aria, cva]
dependency_graph:
  requires: []
  provides: [synchronous-raf-mock, section-aria-hidden, test-visibility-pattern]
  affects: [all-test-files, Section.tsx, Button.test.tsx]
tech_stack:
  added: []
  patterns: [aria-hidden-for-css-animated-collapse, visibility-hidden-for-test-detection, synchronous-raf-mock]
key_files:
  created: []
  modified:
    - gui-app/src/test/setup.ts
    - gui-app/src/shared/ui/Section.tsx
    - gui-app/src/shared/ui/Section.test.tsx
    - gui-app/src/shared/ui/Button.test.tsx
decisions:
  - "RAF mock через global.requestAnimationFrame = cb => { cb(0); return 0; } делает double-RAF в Modal синхронным"
  - "Section.tsx: visibility:hidden + aria-hidden на collapsed wrapper — jsdom понимает visibility, css grid не понимает"
  - "Section.test.tsx: toBeVisible() вместо toBeInTheDocument() для collapsed content"
  - "Button.test.tsx: h-10 для lg размера (CVA: sm=h-8, md=h-9, lg=h-10)"
metrics:
  duration: "~5 min"
  completed: "2026-04-15T10:11:20Z"
  tasks_completed: 2
  files_modified: 4
---

# Phase 8 Plan 01: Test infrastructure — RAF mock, Section visibility, Button CVA Summary

**One-liner:** Синхронный RAF mock в setup.ts + visibility:hidden/aria-hidden в Section.tsx + исправленные assertions — закрывает root causes #1, #2, #4 для 31 зелёных тестов.

## What Was Built

Инфраструктурные фиксы тест-среды, устраняющие три из четырёх root causes провалившихся тестов:

1. **RAF mock (`setup.ts`)** — `global.requestAnimationFrame` теперь синхронно вызывает коллбэк с `cb(0)`. Это делает double-RAF паттерн Modal.tsx (`requestAnimationFrame(() => requestAnimationFrame(() => setAnimating(true)))`) синхронным в тестах, так что `mounted` и `animating` оба становятся `true` немедленно. 13 Modal тестов проходят.

2. **Section.tsx accessibility fix** — Collapsible wrapper получил два атрибута:
   - `visibility: showContent ? undefined : "hidden"` — inline style, который jsdom вычисляет (в отличие от CSS grid)
   - `aria-hidden={!showContent}` — стандартный ARIA атрибут для screen readers

3. **Section.test.tsx** — Два теста переведены с `not.toBeInTheDocument()` на `not.toBeVisible()`. Collapsed content остаётся в DOM для CSS-анимации, но `toBeVisible()` видит `visibility:hidden` на предке.

4. **Button.test.tsx** — Тест "applies lg size classes": `h-9` заменён на `h-10` (CVA реальные размеры: sm=h-8, md=h-9, lg=h-10).

## Verification Results

```
Test Files  3 passed (3)
     Tests  31 passed (31)
  Duration  1.20s
```

- Modal: 13/13
- Button: 12/12
- Section: 6/6

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] aria-hidden недостаточно для toBeVisible() в jest-dom**

- **Found during:** Task 2 (первый прогон Section тестов)
- **Issue:** `toBeVisible()` в `@testing-library/jest-dom` проверяет CSS `display/visibility/opacity` через `getComputedStyle`, а также HTML атрибут `hidden`. Атрибут `aria-hidden` на родителе не влияет на `toBeVisible()`. jsdom не вычисляет CSS grid (`grid-template-rows: 0fr`), поэтому элемент считался видимым.
- **Fix:** Добавлен `style={{ visibility: showContent ? undefined : "hidden" }}` на collapsed wrapper в Section.tsx — jsdom понимает inline visibility, что делает `not.toBeVisible()` рабочим.
- **Files modified:** `gui-app/src/shared/ui/Section.tsx`
- **Commit:** a95e0f2d (включено в основной коммит)

## Known Stubs

None.

## Threat Flags

None. RAF mock изолирован в vitest setupFiles — не влияет на production bundle.

## Self-Check: PASSED

- `gui-app/src/test/setup.ts` содержит `global.requestAnimationFrame` ✓
- `gui-app/src/test/setup.ts` содержит `global.cancelAnimationFrame` ✓
- `gui-app/src/shared/ui/Section.tsx` содержит `aria-hidden={!showContent}` ✓
- `gui-app/src/shared/ui/Section.tsx` содержит `visibility` ✓
- `gui-app/src/shared/ui/Section.test.tsx` содержит `not.toBeVisible()` ✓
- `gui-app/src/shared/ui/Button.test.tsx` содержит `h-10` ✓
- Коммит a95e0f2d существует ✓
