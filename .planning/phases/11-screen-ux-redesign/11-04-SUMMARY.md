---
phase: 11-screen-ux-redesign
plan: "04"
subsystem: shared-ui, server-panel
tags: [overflow-menu, users-section, aria, accessibility, fitts-law]
dependency_graph:
  requires: ["11-03"]
  provides: ["OverflowMenu shared/ui component", "DC-05 fix in UsersSection"]
  affects: ["gui-pro/src/shared/ui/OverflowMenu.tsx", "gui-pro/src/components/server/UsersSection.tsx"]
tech_stack:
  added: ["OverflowMenu component (createPortal, aria menu pattern)"]
  patterns: ["portal dropdown", "ARIA menu role/menuitem", "keyboard navigation"]
key_files:
  created:
    - gui-pro/src/shared/ui/OverflowMenu.tsx
  modified:
    - gui-pro/src/shared/ui/index.ts
    - gui-pro/src/components/server/UsersSection.tsx
    - gui-pro/src/components/server/UsersSection.test.tsx
decisions:
  - "OverflowMenu uses createPortal to render dropdown under document.body (same pattern as VersionSection)"
  - "Items accessed via role=menuitem — tests updated from CSS selector queries to ARIA role queries"
  - "Trigger is h-9 w-9 (36px) per O-05 touch target requirement"
metrics:
  duration: "~15 min"
  completed: "2026-04-15"
  tasks_completed: 2
  files_changed: 4
---

# Phase 11 Plan 04: OverflowMenu Component + UsersSection Integration Summary

**One-liner:** Portal-based overflow menu (role=menu/menuitem, keyboard nav, destructive variant) replaces 4 inline IconButtons in UsersSection per DC-05 Fitts's Law fix.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create OverflowMenu shared/ui component + export | 912dabce | OverflowMenu.tsx, index.ts |
| 2 | Integrate OverflowMenu into UsersSection | ee862c91 | UsersSection.tsx, UsersSection.test.tsx |

## What Was Built

### OverflowMenu (`gui-pro/src/shared/ui/OverflowMenu.tsx`)

Новый переиспользуемый компонент overflow menu для shared/ui:

- **Trigger**: IconButton с иконкой `MoreHorizontal`, h-9 w-9 (36px touch target, O-05), `aria-haspopup="menu"`, `aria-expanded`
- **Dropdown**: рендерится через `createPortal(menu, document.body)` — позиционирование fixed ниже trigger через `getBoundingClientRect`
- **ARIA**: `role="menu"` на контейнере, `role="menuitem"` на каждом элементе
- **Закрытие**: click outside (mousedown listener), Escape key (с возвратом фокуса на trigger), после выбора пункта
- **Keyboard nav**: ArrowDown/Up (переход между enabled items), Home/End (первый/последний), Enter/Space (activate)
- **Variants**: `destructive: true` (color: var(--color-destructive)), `disabled`, `loading` (Loader2 spinner), `icon` (ReactNode перед label)
- **Focus management**: при открытии автоматический фокус на первый enabled item через requestAnimationFrame

### UsersSection интеграция

- 4 inline IconButton (QR/link/download/delete) заменены на один `<OverflowMenu>` per user row
- `triggerAriaLabel={t("users.actions_menu")}` — "Действия с пользователем"
- Delete item: `destructive: true, disabled: serverInfo.users.length <= 1`
- Вся функциональность сохранена: handleShowQR, handleCopyLink, handleDownloadConfig, setConfirmDeleteUser
- Удалены неиспользуемые импорты: Trash2, Download, QrCode, Link2, IconButton

### Обновление тестов

Тесты переписаны с CSS-selector стратегии на ARIA role queries:
- **Было**: `document.querySelectorAll("button[style*='color: var(--color-danger-400)']")`
- **Стало**: `screen.getByRole("menuitem", { name: i18n.t("server.users.delete_tooltip") })`
- Добавлен helper `openOverflowMenu(index)` для открытия меню конкретного пользователя
- Добавлены новые тесты: overflow trigger присутствует per user, aria-haspopup, destructive color
- Итого: 38 тестов, все проходят

## Verification

- `npm run typecheck` — ноль ошибок в новых файлах (OverflowMenu.tsx, обновлённый UsersSection.tsx)
- `npx vitest run src/components/server/UsersSection.test.tsx` — 38/38 passed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] UsersSection.test.tsx — тесты искали кнопки по CSS inline-стилям**
- **Found during:** Task 2
- **Issue:** Старые тесты использовали `document.querySelectorAll("button[style*='color: var(--color-danger-400)']")` и `button[style*='color: var(--color-text-muted)']` — прямые селекторы по стилям устаревшей реализации. После замены на OverflowMenu 16 тестов провалились.
- **Fix:** Переписаны тесты с использованием ARIA queries (`role="menuitem"`, `aria-haspopup`). Добавлен helper `openOverflowMenu()`. Добавлены новые тесты для проверки overflow menu ARIA атрибутов.
- **Files modified:** `gui-pro/src/components/server/UsersSection.test.tsx`
- **Commit:** ee862c91

## Known Stubs

Нет — все действия пользователей полностью проводятся через существующие обработчики.

## Threat Flags

Нет — OverflowMenu является чистым UI компонентом, не вводит новых путей данных или точек доверия.

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| OverflowMenu.tsx exists | FOUND |
| index.ts updated | FOUND |
| UsersSection.tsx updated | FOUND |
| 11-04-SUMMARY.md exists | FOUND |
| Commit 912dabce (Task 1) | FOUND |
| Commit ee862c91 (Task 2) | FOUND |
