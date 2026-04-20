---
phase: 13-ip-tls-ping-drill-down
plan: 02
subsystem: ui
tags: [react-hook, polling, ssh, exponential-backoff, vitest, fake-timers, tdd]

# Dependency graph
requires:
  - phase: 12-5-skeleton-activity-log-foundation
    provides: useServerState (sshParams shape), translateSshError, formatError, OverviewSection skeleton-states
provides:
  - useServerStats hook — polling server_get_stats каждые 10s с visibility pause и exponential backoff
  - ServerStats TypeScript-тип, зеркалит server_monitoring.rs JSON shape
  - 6 unit-тестов с vi.useFakeTimers, готовый settleAndTick helper для будущих polling-хуков
affects:
  - 13-06 (OverviewSection wiring) — потребитель useServerStats для карточек CPU/RAM/Uptime/Пользователи
  - 13-07 (тесты OverviewSection) — может моковать useServerStats напрямую вместо invoke

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Recursive setTimeout вместо setInterval для динамического backoff без перезапуска useEffect
    - SshParams destructure для стабильных useCallback deps (повторно из useSecurityState.ts)
    - failureRef + failureCount split (ref для синхронного backoff, state для useEffect dep)

key-files:
  created:
    - gui-pro/src/components/server/useServerStats.ts
    - gui-pro/src/components/server/useServerStats.test.ts
  modified: []

key-decisions:
  - "Recursive setTimeout (а не setInterval) — каждый тик планируется с актуальным backoff на основе failureRef.current. Позволяет варьировать интервал без перезапуска useEffect, что устраняет лавину immediate-fire вызовов на каждом инкременте failureCount."
  - "First fire планируется через nextDelay (10s default), НЕ immediate — тесты с settleAndTick (advance 0 + advance 10_000) ожидают ровно 1 вызов после первого цикла."
  - "Backoff sequence [10s, 30s, 60s] зафиксирован как const массив; индексация через failureRef.current >= 3 (60s) | >= 2 (30s) | else intervalMs."

patterns-established:
  - "Hook polling pattern: useEffect с cancelled-flag + рекурсивный scheduleNext через setTimeout — переиспользуем для будущих SSH-polling хуков (D-15)."
  - "Test settleAndTick helper копируется из useDashboardState.test.ts — канон для всех polling-тестов на vi.useFakeTimers."

requirements-completed: [D-01, D-02, D-03, D-13, D-15, D-19]

# Metrics
duration: 3min
completed: 2026-04-17
---

# Phase 13 Plan 02: useServerStats polling hook Summary

**React-хук `useServerStats(sshParams, { enabled, intervalMs })` с polling 10s, visibility pause при `enabled=false` и exponential backoff `10s → 30s → 60s` после 3 fail подряд через рекурсивный setTimeout.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-04-17T01:04:16Z
- **Completed:** 2026-04-17T01:08:00Z
- **Tasks:** 2 (TDD: RED → GREEN)
- **Files created:** 2

## Accomplishments

- Создан полностью покрытый тестами polling-хук для карточек CPU/RAM/Uptime/Пользователи
- 6 unit-тестов с `vi.useFakeTimers + advanceTimersByTimeAsync` — canonical паттерн `settleAndTick` повторён из `useDashboardState.test.ts`
- Корректно реализован exponential backoff `[10s, 30s, 60s]` через рекурсивный `setTimeout` (а не `setInterval`) — устраняет race между state setFailureCount и effect re-run
- Чистый TypeScript strict + ESLint --max-warnings 0 (после auto-fix лишнего `eslint-disable-next-line`)

## Task Commits

Каждая задача закоммичена атомарно:

1. **Task 13-02-TASK-01 (RED): useServerStats.test.ts** — `afc5b0a8` (test)
2. **Task 13-02-TASK-02 (GREEN): useServerStats.ts** — `07426557` (feat) — включая Rule 1 fix лишнего eslint-disable

_TDD-цикл: RED-коммит фиксирует "Cannot find module './useServerStats'" → GREEN-коммит делает все 6 тестов зелёными._

## Files Created/Modified

- `gui-pro/src/components/server/useServerStats.ts` (134 строки) — хук + типы `ServerStats`, `SshParams`, константа `BACKOFF_SEQUENCE`, JSDoc с обоснованием recursive setTimeout
- `gui-pro/src/components/server/useServerStats.test.ts` (225 строк) — 6 it-блоков (poll 10s / no poll on disabled / stop on flip / backoff after 3 fails / reset failureCount / error state)

## Decisions Made

- **Recursive `setTimeout` вместо `setInterval`:** причина в реализации D-13. Backoff требует менять интервал между тиками, а `setInterval` даёт фиксированный период. Альтернатива — пересоздавать `setInterval` через `useEffect` deps на `failureCount` — приводит к лавине вызовов из-за immediate-fire паттерна. Recursive `setTimeout` решает оба требования: backoff применяется на каждом следующем планировании; `useEffect` зависит только от `enabled/fetchStats/intervalMs` и не пересоздаёт цикл при каждом fail.
- **First fire — через `nextDelay`, не immediate:** Изначальная попытка использовать `void fetchStats()` сразу + `setInterval` ломала тест 4 (ожидает callCount=1 после `settleAndTick`). Тесты — спецификация контракта; отказался от immediate-fire ради детерминированного поведения. На UX-уровне 10s задержки до первого значения карточек приемлемы (показывается Skeleton), и это соответствует ожиданию пользователя при первом монтировании Обзора.
- **failureRef vs failureCount split:** `failureRef.current` — синхронное чтение для расчёта `nextDelay` внутри `scheduleNext`. `failureCount` state — только для возврата наружу (D-15) и потенциального будущего вывода в UI. Не использую `failureCount` в deps `useEffect`, потому что setTimeout-планировщик уже видит свежий ref.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Реализация `setInterval` вызывала лавину вызовов**

- **Found during:** Task 13-02-TASK-02 (первая попытка имплементации)
- **Issue:** Изначальная реализация по шаблону плана использовала `void fetchStats()` immediate + `setInterval(fetchStats, currentInterval)` с зависимостью useEffect от `failureCount`. На каждом fail `setFailureCount` инкрементировался → useEffect перезапускался → cleanup → immediate `fetchStats` → ещё fail → лавина (тест 4 видел `callCount=6` вместо 1, тест 6 уходил в timeout 5s).
- **Fix:** Заменил на рекурсивный `setTimeout` с локальным `cancelled` флагом и `scheduleNext()` функцией, которая динамически рассчитывает `nextDelay` из `failureRef.current` перед каждым новым `setTimeout`. `useEffect` зависит только от `enabled/fetchStats/intervalMs` (не от `failureCount`), что устраняет race. First fire планируется через `nextDelay`, не immediate.
- **Files modified:** `gui-pro/src/components/server/useServerStats.ts`
- **Verification:** Все 6 тестов зелёные (`npx vitest run src/components/server/useServerStats.test.ts`).
- **Committed in:** `07426557` (часть Task-02 GREEN)

**2. [Rule 1 - Lint] Удалён лишний `eslint-disable-next-line react-hooks/exhaustive-deps`**

- **Found during:** Task 13-02-TASK-02 (lint check после успешного teста)
- **Issue:** Шаблон плана (строки 560-561) включал `// eslint-disable-next-line react-hooks/exhaustive-deps` перед deps массивом `useCallback`. ESLint v9 не нашёл проблем с deps (`[host, port, user, password, keyPath, t]` корректно покрывает все зависимости) и пожаловался на неиспользуемую директиву.
- **Fix:** Удалил `// eslint-disable-next-line react-hooks/exhaustive-deps` — все зависимости явно перечислены и валидны.
- **Files modified:** `gui-pro/src/components/server/useServerStats.ts`
- **Verification:** `npx eslint src/components/server/useServerStats.ts --max-warnings 0` чистый.
- **Committed in:** `07426557` (часть Task-02 GREEN)

---

**Total deviations:** 2 auto-fixed (1 bug в реализации backoff, 1 lint)
**Impact on plan:** Backoff-fix критичен для D-13 корректности (без него хук бомбардировал бы SSH-канал). Lint-fix необходим для CI прохождения (`max-warnings 0` в проекте). Внешний контракт хука и сигнатура остались строго по D-15.

## Issues Encountered

- Первый прогон тестов после реализации показал 2 падения (тест backoff + тест error state). Диагностика: `failureCount` в useEffect deps + immediate-fire паттерн = лавина вызовов. Решено через переход на recursive `setTimeout`. Параллельные worktree-агенты других планов phase 13 (13-01, 13-03, 13-04, 13-05) уже коммитили свои файлы в общую ветку — мой rebase прошёл чисто, файлы scope не пересекались.

## User Setup Required

None — внутренний хук, никаких внешних зависимостей или конфигурации.

## Next Phase Readiness

- **Plan 13-06 (OverviewSection live wiring):** готов вызвать `useServerStats(sshParams, { enabled: isOverviewVisible && !rebooting, intervalMs: 10_000 })` и читать `{ stats, loading, error }` для CPU/RAM/Uptime/Пользователи карточек.
- **Plan 13-07 (OverviewSection tests):** может моковать `useServerStats` через `vi.mock('./useServerStats', () => ({ useServerStats: () => ({ stats, loading: false, error: null, failureCount: 0 }) }))` вместо моков `invoke` — упрощает тестирование UI-логики.
- **Не блокировано:** хук self-contained, не требует регистрации Tauri-команды или изменений в backend (использует уже существующий `server_get_stats`).

## Self-Check: PASSED

- [x] `gui-pro/src/components/server/useServerStats.ts` существует
- [x] `gui-pro/src/components/server/useServerStats.test.ts` существует
- [x] Коммит `afc5b0a8` (test RED) присутствует в `git log`
- [x] Коммит `07426557` (feat GREEN) присутствует в `git log`
- [x] `npx vitest run useServerStats.test.ts` → 6/6 зелёные
- [x] `npx eslint useServerStats*.ts --max-warnings 0` чистый
- [x] `npx tsc --noEmit` чистый

## TDD Gate Compliance

- **RED gate:** `afc5b0a8` (`test(13-02): add failing tests for useServerStats hook (RED)`) — модуль `./useServerStats` не существовал, vitest зафиксировал "Failed to resolve import". Корректный RED.
- **GREEN gate:** `07426557` (`feat(13-02): implement useServerStats polling hook (GREEN)`) — все 6 тестов зелёные после реализации.
- **REFACTOR gate:** не требовался; небольшая правка lint-disable выполнена в рамках GREEN-коммита (atomic).

---
*Phase: 13-ip-tls-ping-drill-down*
*Completed: 2026-04-17*
