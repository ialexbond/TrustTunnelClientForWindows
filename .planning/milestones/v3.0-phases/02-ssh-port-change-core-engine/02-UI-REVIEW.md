# Phase 2 — UI Review (Post-Fix)

**Аудит:** 2026-04-14
**Базис:** 02-UI-SPEC.md (design contract)
**Визуальная проверка:** Storybook dev-сервер, все 25 компонентов осмотрены в dark theme

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 4/4 | Все строки контракта реализованы, русская локализация, нет generic-лейблов |
| 2. Visuals | 3/4 | 4 компонента (Modal, ConfirmDialog, Card, Tooltip) не используют cn() для className merge |
| 3. Color | 4/4 | Zero hardcoded hex/rgba. Все цвета через CSS custom properties. Несуществующие токены исправлены |
| 4. Typography | 4/4 | Только weight 400 и 600 через токены. Zero font-medium. Zero text-[10px] |
| 5. Spacing | 3/4 | Tailwind-числа (px-4, py-2, gap-2) в PanelErrorBoundary/SnackBar вместо токенов |
| 6. Experience Design | 4/4 | Полное покрытие состояний, ARIA roles корректны, баги ConfirmDialog/SnackBar/DropOverlay исправлены |

**Overall: 22/24**

---

## Исправленные проблемы (этот аудит)

Следующие баги найдены первым аудитом и исправлены в коммите `c8136724`:

| Проблема | Файл | Было | Стало |
|----------|------|------|-------|
| Несуществующий Button variant | ConfirmDialog.tsx:73 | `variant="warning"` | `variant="primary"` |
| Несуществующий z-index токен | DropOverlay.tsx:19 | `var(--z-overlay)` | `var(--z-modal)` |
| Несуществующий color токен | SnackBar.tsx:207 | `var(--color-status-success)` | `var(--color-status-connected)` |
| Hardcoded backdrop | Modal.tsx:55 | `bg-black/40` | `bg-[var(--color-glass-bg)]` |
| Hardcoded backdrop | DropOverlay.tsx:22 | `rgba(0,0,0,0.4)` | `var(--color-glass-bg)` |
| Hardcoded textShadow | DropOverlay.tsx:35 | `rgba(0,0,0,0.5)` | `var(--color-glass-bg)` |
| Hardcoded toggle thumb | Toggle.tsx:93 | `bg-white` | `bg-[var(--color-toggle-thumb,#fff)]` |
| Hardcoded hover | SnackBar.tsx:45 | `hover:bg-white/10` | `hover:bg-[var(--color-bg-hover)]` |
| font-medium (weight 500) | 8 файлов | `font-medium` | `font-[var(--font-weight-semibold)]` |
| text-[10px] вне токенов | Toggle.tsx:63 | `text-[10px]` | `text-[var(--font-size-xs)]` |
| text-xs вне токенов | DropOverlay.tsx:55 | `text-xs` | `text-[var(--font-size-xs)]` |
| Примитивный токен вместо семантического | Card.tsx:48 | `--color-accent-400` | `--color-accent-interactive` |
| SnackBar font weight | SnackBar.tsx:182 | `font-medium` | `font-[var(--font-weight-normal)]` |

---

## Оставшиеся рекомендации

### Visuals (3/4 → 4/4)

**cn() adoption в 4 компонентах:**
Modal, ConfirmDialog, Card, Tooltip используют template literal для className вместо cn(). Consumer не может переопределить стили через className (twMerge не работает).

| Файл | Текущий | Рекомендация |
|------|---------|-------------|
| Card.tsx:19 | `` `${paddingMap[padding]} ${className}` `` | `cn(paddingMap[padding], className)` |
| Modal.tsx:59 | `` `w-full ${sizeClasses[size]} ... ${className}` `` | `cn("w-full", sizeClasses[size], ..., className)` |
| ConfirmDialog.tsx | без className prop | Добавить className + cn() |
| Tooltip.tsx:64 | inline styles | Рассмотреть cn() для className |

### Spacing (3/4 → 4/4)

**Tailwind-числа вместо токенов:**

| Файл | Значение | Токен-эквивалент |
|------|---------|-----------------|
| PanelErrorBoundary.tsx:49 | `p-8` | `p-[var(--space-7)]` |
| PanelErrorBoundary.tsx:65 | `px-4 py-2` | `px-[var(--space-4)] py-[var(--space-2)]` |
| PanelErrorBoundary.tsx:61 | `gap-2` | `gap-[var(--space-2)]` |
| SnackBar.tsx:181 | `px-4 py-2.5` | `px-[var(--space-4)] py-[var(--space-2)]` |
| EmptyState.tsx:22 | `gap-3 py-8` | `gap-[var(--space-3)] py-[var(--space-7)]` |
| Input.tsx:91 | `right-2` | `right-[var(--space-2)]` |

Значения кратны 4px и эквивалентны токенам — визуальных проблем нет, вопрос формальной консистентности.

### Stories

**PanelErrorBoundary** показывает i18n-ключи ("errors.panelCrash") вместо русского текста. Рекомендация: в stories подключить mock i18n или передать fallback.

**Modal/ConfirmDialog** — нет story с `isOpen: true` для inline-preview открытого состояния.

### Тесты

7 компонентов без unit-тестов: ActionInput, ActionPasswordInput, EmptyState, Separator, ProgressBar, IconButton, PanelErrorBoundary. Рекомендация: добавить при миграции экранов (Phase 3-4), когда consumer-контекст станет яснее.

---

## Визуальная проверка (Storybook)

Все 25 компонентов осмотрены в dark theme:

| # | Компонент | Статус | Заметки |
|---|-----------|--------|---------|
| 1 | Button | PASS | 4 варианта, 3 размера, states: default/disabled/loading |
| 2 | Badge | PASS | 5 вариантов: connected/connecting/error/neutral/dot |
| 3 | ErrorBanner | PASS | 3 severity с иконками и dismiss |
| 4 | Input | PASS | Default, value, error, disabled, helper, clearable |
| 5 | NumberInput | PASS | With label, helper text, error, min/max |
| 6 | PasswordInput | PASS | Eye-toggle, placeholder "Enter password..." |
| 7 | ActionInput | PASS | 7 stories: label, helper, error, action, multiple actions, disabled |
| 8 | ActionPasswordInput | PASS | 8 stories: label, helper, error, action, show password, no lock icon, disabled |
| 9 | Card | PASS | With Header: icon (accent), title, action slot |
| 10 | ConfirmDialog | PASS | "Open Dialog" trigger, danger/warning variants |
| 11 | Modal | PASS | sm/md/lg sizes, with title, long content |
| 12 | DropOverlay | PASS | Default (hidden), Active, Interactive |
| 13 | IconButton | PASS | Gear icon, aria-label="Settings", tooltip, disabled, loading |
| 14 | Toggle | PASS | Off/On/Disabled off/Disabled on, thumb через токен |
| 15 | Select | PASS | With Selection "Option 2", chevron-down, 7 stories |
| 16 | Tooltip | PASS | "Hover me", positions, long text |
| 17 | Section | PASS | "Дополнительные параметры" collapsible, chevron, 7 stories |
| 18 | Separator | PASS | Horizontal, vertical, with label, in form layout |
| 19 | SnackBar | PASS | Success/error triggers, auto dismiss |
| 20 | StatusBadge | PASS | ОТКЛЮЧЕНО/ПОДКЛЮЧЕНИЕ.../ПОДКЛЮЧЕНО/ОШИБКА с dot |
| 21 | FormField | PASS | "Сервер *" required, error state с красным текстом |
| 22 | EmptyState | PASS | With Icon: envelope, "Список пуст" |
| 23 | ProgressBar | PASS | 50% fill accent, label, value, animated |
| 24 | PanelErrorBoundary | PASS | Warning triangle, retry button |
| 25 | SnackBarContext | N/A | Context provider, нет визуального рендера |

---

## Files Audited

**Компоненты (25 файлов):** gui-app/src/shared/ui/*.tsx
**Инфраструктура:** gui-app/src/shared/lib/cn.ts, gui-app/src/shared/styles/tokens.css
**Exports:** gui-app/src/shared/ui/index.ts (25 exports)
**Планы:** 02-01 через 02-07 PLAN.md и SUMMARY.md
