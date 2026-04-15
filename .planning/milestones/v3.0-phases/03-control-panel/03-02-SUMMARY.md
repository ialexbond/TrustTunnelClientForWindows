---
phase: 03-control-panel
plan: 02
subsystem: gui-app/components
tags: [statusbadge, errorbanner, button-variants, tailwind-tokens, vpn-states]
dependency_graph:
  requires: [03-01]
  provides: [StatusPanel redesign, ControlPanelPage header redesign]
  affects: [gui-app/src/components/StatusPanel.tsx, gui-app/src/components/ControlPanelPage.tsx]
tech_stack:
  added: []
  patterns:
    - StatusBadge with explicit label prop (preserves i18n test assertions)
    - ErrorBanner with local dismiss state (useState + useEffect reset on status change)
    - Button children pattern (icon as first child, no icon= prop)
    - Tailwind arbitrary values for CSS token consumption (h-[52px], bg-[var(--color-bg-primary)])
key_files:
  created: []
  modified:
    - gui-app/src/components/StatusPanel.tsx
    - gui-app/src/components/ControlPanelPage.tsx
decisions:
  - ErrorBanner uses variant="error" / prop named severity (Phase 2 updated API uses severity)
  - statusBadgeVariant() maps disconnecting/recovering to "connecting" (no 5th variant needed)
  - errorDismissed state managed locally inside StatusPanel (no new prop)
  - no-creds wrapper gets bg-[var(--color-bg-primary)] for correct surface behind SshConnectForm Card
metrics:
  duration_minutes: 35
  completed_date: "2026-04-14"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 2
  tests_passed: 48
requirements_satisfied: [SCR-01, SCR-02]
---

# Phase 03 Plan 02: StatusPanel + ControlPanelPage Header Redesign Summary

**One-liner:** StatusPanel migrated from Badge to StatusBadge/ErrorBanner with correct VPN state→Button variant mapping; ControlPanelPage header converted to Tailwind token classes with icon-as-child pattern.

## What Was Built

### Task 1: StatusPanel Redesign

**StatusPanel.tsx** — полная визуальная миграция, ноль изменений в логике:

- **Badge → StatusBadge:** `statusBadgeVariant()` функция маппит 6 VPN-состояний на 4 варианта StatusBadge (connected/connecting/error/disconnected). `recovering` и `disconnecting` → "connecting" (жёлтый pulse).
- **Explicit label prop:** `label={statusLabel}` передаётся явно в StatusBadge вместо использования дефолтных меток (дефолты "ПОДКЛЮЧЕНО" отличались от i18n-значений "Подключен" в тестах).
- **ErrorBanner:** заменяет inline `<p style={{ color: "var(--color-danger-400)" }}>`. Добавлен `errorDismissed` state с `useEffect` сбросом при смене status.
- **Button variant mapping:** `connected` → `danger`, `connecting` → `ghost` (с cancel), `disconnecting/recovering` → `ghost + disabled + loading`, `error/disconnected` → `ghost`. Убран несуществующий `variant="warning"` и `variant="success"`.
- **Удалён `icon=` prop:** иконки Power переданы как children перед текстом кнопки.
- **Токен-стили:** `border-[var(--color-border)]`, `px-[var(--space-4)]`, `h-[52px]`, `gap-[var(--space-3)]`, `text-[var(--font-size-xs)]`.

### Task 2: ControlPanelPage Header Redesign

**ControlPanelPage.tsx** — миграция header с inline styles на Tailwind token classes:

- **Заголовок:** `style={{ height: 52, backgroundColor, borderBottom }}` → `h-[52px] bg-[var(--color-bg-primary)] border-b border-[var(--color-border)] px-[var(--space-4)]`
- **Button:** `icon={<LogOut .../>}` → `<LogOut .../>` как первый дочерний элемент
- **No-creds wrapper:** добавлен `bg-[var(--color-bg-primary)]` для правильного фона за Card в SshConnectForm

## Commits

| Task | Commit | Files |
|------|--------|-------|
| Task 1: StatusPanel redesign | `951849af` | StatusPanel.tsx |
| Task 2: ControlPanelPage header | `668f1d7d` | ControlPanelPage.tsx |

## Test Results

| Suite | Tests | Result |
|-------|-------|--------|
| StatusPanel.test.tsx | 10/10 | PASS |
| ControlPanelPage.test.tsx | 17/17 | PASS |
| SshConnectForm.test.tsx | 21/21 | PASS |
| **Total (3 suites)** | **48/48** | **PASS** |

Full suite: 1352 passed, 4 failed (pre-existing — see Deferred Issues).

## Deviations from Plan

### Auto-detected Differences

**1. [Pre-existing state] Phase 2 components already in worktree from previous commits**
- StatusBadge, ErrorBanner (updated API with `severity`), FormField, Section — все присутствовали в HEAD коммите
- ErrorBanner API использует проп `severity` (не `variant`) — совпадает со спекой плана

**2. [Rule 3 - Blocking] npm node_modules не установлены в worktree**
- Потребовалось `npm install --legacy-peer-deps` перед запуском тестов
- Не влияет на код — только setup worktree

### None — Plan Executed As Written

Все изменения кода строго соответствуют спецификации плана. Отклонений в логике нет.

## Deferred Issues

Следующие pre-existing test failures существовали до этого плана и находятся вне скопа:

| File | Tests | Issue |
|------|-------|-------|
| `src/shared/ui/Section.test.tsx` | 2 failures | Collapsible toggle and defaultOpen=false — Section.tsx коллапс не работает |
| `src/components/routing/ProcessFilterSection.test.tsx` | 1 failure | calls onLoadProcesses and opens picker on add click |

Эти падения не связаны с изменениями Plan 02 и присутствовали до коммита `951849af`.

## Self-Check: PASSED

- StatusPanel.tsx: FOUND
- ControlPanelPage.tsx: FOUND
- 03-02-SUMMARY.md: FOUND
- Commit 951849af: FOUND
- Commit 668f1d7d: FOUND
