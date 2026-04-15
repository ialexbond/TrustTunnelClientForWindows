---
phase: 10-tab-bar-control-panel
plan: "01"
subsystem: ui/navigation
tags: [tab-navigation, animation, accessibility, cross-fade]
dependency_graph:
  requires: []
  provides: [animated-pill-indicator, cross-fade-tab-panels]
  affects: [TabNavigation.tsx, App.tsx]
tech_stack:
  added: []
  patterns: [translateX-pill-animation, visibility-opacity-crossfade, useRef-getBoundingClientRect]
key_files:
  created: []
  modified:
    - gui-app/src/components/layout/TabNavigation.tsx
    - gui-app/src/App.tsx
decisions:
  - "Pill uses translateX (not left) for animation — GPU-accelerated, locked decision D-01/NAV-01"
  - "Active panel position:relative, inactive position:absolute inset:0 — avoids layout collapse"
  - "visibility:hidden on inactive panels — prevents screen reader access per T-10-01"
metrics:
  duration: "~2 min"
  completed: "2026-04-15"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 2
---

# Phase 10 Plan 01: Pill Indicator + Cross-fade Tab Panels Summary

**One-liner:** Animated pill indicator via translateX+useRef and visibility/opacity cross-fade on all 5 tab panels.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Pill indicator in TabNavigation via translateX + useRef | f4f2586f | TabNavigation.tsx |
| 2 | Cross-fade tab panels in App.tsx + D-17 layout shift fix | 23e8fe48 | App.tsx |

## What Was Built

### Task 1 — TabNavigation pill indicator

`TabNavigation.tsx` теперь содержит pill-div, абсолютно позиционированный внутри flex-контейнера. Позиция вычисляется через `getBoundingClientRect` при каждом изменении `activeTab` и при ресайзе окна. Анимация реализована через `transform: translateX(Npx)` с переходом `var(--transition-slow) var(--ease-out)` (300ms). Per-button `backgroundColor` для активного состояния удалён — фон теперь даёт pill.

Ключевые решения:
- `left: 0` статично — нет transition на left, только на transform (D-01)
- `marginLeft: 4` + `width: pillWidth - 8` — pill центрирован внутри кнопки с отступом 4px с каждой стороны
- Кнопки получили `position: "relative"` — слоятся выше pill (z-index: auto > z-index: 0)
- `aria-hidden="true"` на pill — декоративный элемент, скрыт от screen reader

### Task 2 — App.tsx cross-fade

Все 5 tab-панелей переведены с `display: flex | none` на `visibility + opacity`:
- Активная панель: `position: relative` (занимает место в потоке)
- Неактивные: `position: absolute; inset: 0` (стекуются поверх, невидимы)
- `transition: "opacity var(--transition-fast)"` — плавный fade 150ms
- `aria-hidden={activeTab !== "X"}` — hidden panels закрыты для assistive technology (T-10-01)
- Content area wrapper: добавлен `relative` + `transition: padding` для D-17 layout shift fix

## Verification

```
Test Files  2 passed (2)
     Tests  70 passed (70)
```

- TabNavigation: 11/11 ✓
- App: 59/59 ✓

## Deviations from Plan

None — план выполнен точно как описано.

## Threat Surface Scan

Новых trust boundary crossings нет. Обе меры из threat model реализованы:
- T-10-01: `aria-hidden={true}` на всех 5 неактивных панелях ✓
- T-10-02: принято (CSS engine обрабатывает прерывания нативно) ✓

## Self-Check

Файлы существуют:
- gui-app/src/components/layout/TabNavigation.tsx ✓
- gui-app/src/App.tsx ✓

Коммиты существуют:
- f4f2586f ✓
- 23e8fe48 ✓

## Self-Check: PASSED
