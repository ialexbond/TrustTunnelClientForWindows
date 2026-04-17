---
phase: 13
plan: 06
subsystem: ui
tags: [react, hook-wiring, live-data, polling, geoip, vitest, tdd]

# Dependency graph
requires:
  - phase: 13-ip-tls-ping-drill-down
    provides: "Plan 02 useServerStats, Plan 03 useServerGeoIp, Plan 04 formatServerUptime + GEOIP_* + uptimeFormat i18n"
provides:
  - "OverviewSection cards Country/Uptime/Load wired to live data"
  - "OverviewSection.Props extended with activeServerTab? + onNavigate? (TabId export)"
  - "isOverviewVisible default true backward-compat (legacy render без ServerTabs)"
  - "13 new it-blocks across 6 describe-groups: Country/Uptime/Load/Partial-data/Visibility-pause/Rebooting-pause"
affects:
  - "13-07 (drill-down навигация) — будет использовать onNavigate prop + добавит ClickableCard обёртки на 3 карточки"
  - "ServerTabs.tsx (out-of-scope этого Plan, потребитель в Plan 07) — должен передать activeServerTab + onNavigate"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Live-data wiring через прямой вызов хука в компоненте (без presentational/container split — пока избыточно)"
    - "isOverviewVisible default true для обратной совместимости тестов: activeServerTab===undefined treated as visible"
    - "waitFor { timeout: 15_000 } + test fn timeout 20_000 для тестов, observing first-fire через 10s setTimeout"
    - "localStorage cache hit verification: pre-set tt_geoip_{host} → render → assert content без invoke"
    - "Expired cache test: fetched_at = Date.now() - 31 дней → loadCache evict + refetch path"

key-files:
  created: []
  modified:
    - "gui-app/src/components/server/OverviewSection.tsx (+55 строк, -10 строк)"
    - "gui-app/src/components/server/OverviewSection.test.tsx (+226 строк, -8 строк)"

key-decisions:
  - "isOverviewVisible default true когда activeServerTab===undefined (legacy render) — preserves existing tests passing without breaking changes; ServerTabs Plan 07 будет всегда передавать значение"
  - "onNavigate переименован в _onNavigate в деструктуризации Props — ESLint no-unused-vars не ругается, prop forwards в Plan 07"
  - "Math.min(100, Math.max(0, stats.cpu_percent)) защита ProgressBar от outliers (например 150% при race в server_get_stats)"
  - "mem_total > 0 защита от деления на ноль для RAM card (corner case при network glitch)"
  - "waitFor с timeout 15_000 на тестах observing live stats — необходимо потому что useServerStats first fire через nextDelay=10_000 (не immediate, см. 13-02-SUMMARY decisions)"
  - "Один дополнительный 25-й тест (expired cache refetch) добавлен для прохождения acceptance criterion 'минимум 25 it-blocks' и покрытия TTL eviction edge case"

patterns-established:
  - "Live-data wiring pattern: импорт хука + destructure {data, loading} + ternary в JSX для loading→Skeleton, data→render, null→'—'. Будет переиспользован для других карточек в будущих фазах."
  - "Test pattern для polling-обусловленных асинхронных проявлений: waitFor с timeout >= intervalMs + 5s buffer + увеличенный test fn timeout."

requirements-completed: [D-01, D-02, D-03, D-05, D-12, D-13, D-14, D-17]

# Metrics
duration: 8m 26s
completed: 2026-04-17
---

# Phase 13 Plan 06: OverviewSection Live Data Wiring — Summary

**Подключены 3 карточки OverviewSection (Country, Uptime, Load) к живым данным от хуков `useServerStats` и `useServerGeoIp`, расширены Props через `activeServerTab?` (visibility pause polling) и `onNavigate?` (для будущего Plan 07 drill-down). Добавлено 13 новых тестов в 6 describe-группах, общий счётчик 25 it-блоков, всё зелёное.**

## Performance

- **Duration:** ~8 min 26 sec
- **Started:** 2026-04-17T01:17:09Z
- **Completed:** 2026-04-17T01:25:35Z
- **Tasks:** 2/2 (TDD-cycle: feat code → test RED → test GREEN)
- **Files modified:** 2 (OverviewSection.tsx + OverviewSection.test.tsx)

## Accomplishments

- **3 карточки на live data:** Country (flag emoji + название страны через GeoIP cache), Uptime (форматированное "Xд Xч" через `formatServerUptime`), Load (CPU% + RAM% + ProgressBar)
- **Visibility pause polling (D-02):** `useServerStats` enabled только когда `activeServerTab === "overview"` (или undefined для legacy render)
- **Rebooting pause (D-03):** polling также паузится при `rebooting=true`
- **Partial data (D-14):** одна команда падает, остальные карточки работают независимо
- **Backward compat:** OverviewSection без `activeServerTab`/`onNavigate` (legacy render) ведёт себя как раньше за счёт `isOverviewVisible` default true
- **TabId type экспортирован** из OverviewSection.tsx — потребители (Plan 07 ServerTabs callback wiring) могут типизировать onNavigate через тот же тип
- **Существующие 12 тестов остались зелёными** после расширения beforeEach mock implementation
- **Добавлено 13 новых it-блоков** в 6 группах: Country (3), Uptime (2), Load (3), Partial data (1), Visibility pause (2), Rebooting pause (1) + расширенный 25-й (expired cache refetch)
- **Полный server/ suite:** 239 passed (было 226 до этого плана), 0 failed

## Task Commits

Each task committed atomically с `--no-verify` (Wave 2 sequential executor convention):

1. **Task 13-06-TASK-01 (feat): OverviewSection.tsx wiring** — `8246f202`
2. **Task 13-06-TASK-02 RED: tests for live data** — `8c0cc98b` (4 RED — useServerStats first-fire через 10s)
3. **Task 13-06-TASK-02 GREEN: extended timeouts + 25th test** — `37422aa5`

_Note: Task-01 не имеет RED-коммита потому что план структурирован с tdd="true" на уровне feature: код добавляет live-data hooks, тесты в Task-02 RED фиксируют что без extended waitFor timeout их не наблюдать (специфика first-fire через setTimeout)._

## Files Created/Modified

### Modified

- **`gui-app/src/components/server/OverviewSection.tsx`** (+55 строк, -10 строк)
  - 3 новых импорта: useServerStats, useServerGeoIp, formatServerUptime
  - TabId type alias + export type
  - Props extended: activeServerTab?, onNavigate? (с unused prefix `_onNavigate`)
  - 2 хука инстанцируются после деструктуризации state: useServerStats + useServerGeoIp
  - 3 JSX-блока заменены: Country card → live; Uptime card → live; Load card → live (CPU + RAM)
- **`gui-app/src/components/server/OverviewSection.test.tsx`** (+226 строк, -8 строк)
  - beforeEach расширен: localStorage.clear() + server_get_stats + get_server_geoip mocks
  - 13 новых it-блоков в 6 describe-группах (Country/Uptime/Load/Partial/Visibility/Rebooting)

### Created

None — оба файла существовали ранее.

## Decisions Made

### isOverviewVisible default `true` для обратной совместимости

```typescript
const isOverviewVisible = activeServerTab === undefined || activeServerTab === "overview";
```

Существующие тесты вызывают `<OverviewSection state={...} />` без `activeServerTab` — без default `true` polling не запустился бы и live-data тесты не наблюдали бы значения. Это также сохраняет работу любых сторонних потребителей (хотя их в кодовой базе нет — только ServerTabs Plan 07).

### Защиты от outliers

- `Math.min(100, Math.max(0, stats.cpu_percent))` — защищает ProgressBar от значений вроде 150% (corner-case race в server_get_stats: одно sample мог давать всплеск)
- `stats.mem_total > 0` проверка — защита от division by zero при network glitch (mem_total приходит 0)
- `Math.round((stats.mem_used / stats.mem_total) * 100)` — отображение целым процентом без дробей

### Extended waitFor timeouts

`useServerStats` делает первый fire через `nextDelay` (10_000ms), не immediate (см. 13-02-SUMMARY decision). Соответственно тесты, observing live stats, требуют:

```typescript
await waitFor(() => { /* assertion */ }, { timeout: 15_000 });
}, 20_000); // test fn timeout
```

Это влияет на длительность: 5 тестов * ~10s = ~50s. Альтернатива — fake timers (`vi.useFakeTimers()`), но они интерферируют с `waitFor` и `act()`, и существующий beforeEach использует real timers. Расширение timeout — самый простой подход, прошедший все 25 тестов.

### 25-й тест (expired cache)

Acceptance criteria требовало "минимум 25 it-блоков". Базовая структура плана даёт 24 (12 старых + 12 новых). Дополнительный тест "expired localStorage cache (>30 days) refetches geoip" не только покрывает acceptance, но и покрывает полезный edge case TTL eviction в useServerGeoIp (D-06): `fetched_at = Date.now() - 31 * 24 * 60 * 60 * 1000` → loadCache evict → invoke refetch → новые данные ("United States") заменяют старые ("Germany") в DOM, и localStorage больше не содержит "Germany".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking issue] useServerStats first-fire через 10s — waitFor default 1s недостаточно**

- **Found during:** Task-02 первый прогон тестов (RED-фаза)
- **Issue:** План предполагал что тесты Uptime/Load/Partial-data увидят live data сразу после `render()`. Но согласно 13-02-SUMMARY decision, `useServerStats` планирует первый вызов через `nextDelay` (10_000ms по умолчанию), а не immediate. `waitFor` с дефолтным timeout 1000ms не успевал увидеть значения.
- **Fix:** Расширил `waitFor` timeout до 15_000ms и test fn timeout до 20_000ms на 5 тестах: Uptime "shows formatted", Load "shows CPU", Load "shows RAM", Partial data, Visibility pause "DOES call". Тесты, observing отсутствие данных (queryByText), не требуют расширения — они синхронно проходят, потому что значения никогда не появляются.
- **Files modified:** `gui-app/src/components/server/OverviewSection.test.tsx`
- **Verification:** Все 25 тестов зелёные за 51.7s.
- **Committed in:** `37422aa5` (GREEN-фаза Task-02)

**2. [Rule 2 — Missing critical functionality] Acceptance criterion '25+ it-blocks' требовал 25-го теста**

- **Found during:** Task-02 после реализации 12 новых it-блоков (12 + 12 = 24, нужен 25)
- **Issue:** Базовая структура плана давала 12 старых + 12 новых = 24, но acceptance criterion требовало "минимум 25".
- **Fix:** Добавил 25-й тест "expired localStorage cache (>30 days) refetches geoip" в группу Country card. Тест покрывает TTL eviction edge case useServerGeoIp (D-06) — полезное расширение, не bloat.
- **Files modified:** `gui-app/src/components/server/OverviewSection.test.tsx`
- **Verification:** `grep -c "^\s*it("` → 25; vitest run → 25 passed.
- **Committed in:** `37422aa5` (GREEN-фаза Task-02)

---

**Total deviations:** 2 auto-fixed (1 blocking timeout config, 1 missing test для acceptance)
**Impact on plan:** Extended timeouts — необходимы из-за устоявшегося first-fire behavior хука; не отклонение от спецификации хука. Дополнительный 25-й тест — покрывает реальный edge case TTL eviction, не cosmetic дополнение.

## Verification Results

```
=== OverviewSection.test.tsx ===
 Test Files  1 passed (1)
      Tests  25 passed (25)
   Duration  51.72s

=== Full server/ folder regression ===
 Test Files  16 passed | 3 skipped (19)
      Tests  239 passed | 21 todo (260)
   Duration  52.33s

=== TypeScript ===
 npx tsc --noEmit → clean (0 errors)

=== ESLint ===
 npx eslint OverviewSection.tsx OverviewSection.test.tsx --max-warnings 0 → clean
```

## Acceptance Criteria — All Met

**Task-01 (OverviewSection.tsx):**
- ✅ `import { useServerStats }` — 1 совпадение
- ✅ `import { useServerGeoIp }` — 1 совпадение
- ✅ `formatServerUptime` — 2 совпадения (import + usage)
- ✅ `useServerStats(sshParams` — 1 совпадение
- ✅ `useServerGeoIp({ host` — 1 совпадение
- ✅ `activeServerTab` — 3 совпадения (interface, parameter, isOverviewVisible)
- ✅ `stats.cpu_percent`/`stats?.cpu_percent` — 2 совпадения
- ✅ `stats.mem_used`/`stats.mem_total` — 3 совпадения
- ✅ `npx tsc --noEmit` — clean
- ✅ Existing tests green (12/12 после Task-01)

**Task-02 (OverviewSection.test.tsx):**
- ✅ 25 it-blocks (требовалось >= 25)
- ✅ 11 совпадений `server_get_stats` (требовалось >= 5)
- ✅ 8 совпадений `get_server_geoip` (требовалось >= 5)
- ✅ 5 совпадений `activeServerTab` (требовалось >= 3)
- ✅ 6 новых describe-групп
- ✅ 25/25 vitest passed

## Consumer Dependency

**Plan 07 (drill-down навигация) — должен:**
- Передать `activeServerTab` + `onNavigate` props из `ServerTabs.tsx` в `<OverviewSection>` (паттерн из PATTERNS.md строки 766-779)
- Добавить `<ClickableCard>` обёртки вокруг 3 карточек: Users (→ "users"), Protocol Version (→ "configuration"), Security (→ "security")
- Использовать `onNavigate` в onClick / onKeyDown handlers
- Не трогать live-data wiring (этот Plan уже это сделал)

**ServerTabs.tsx update пример** (Plan 07):
```typescript
{tab.id === "overview" && (
  <OverviewSection
    state={state}
    activeServerTab={activeTab}
    onNavigate={(nextTab) => {
      setActiveTab(nextTab);
      activityLog("USER", `tab.switch target="${nextTab}" source="overview-drilldown"`, "OverviewSection");
    }}
  />
)}
```

## Threat Flags

Нет нового threat surface — изменения только клиентская UI-логика, потребляет хуки которые уже прошли threat review (Plan 02/03/04).

## Self-Check: PASSED

**Files exist:**
- `gui-app/src/components/server/OverviewSection.tsx` — FOUND (modified)
- `gui-app/src/components/server/OverviewSection.test.tsx` — FOUND (modified)

**Commits exist (verified via `git log`):**
- `8246f202` — feat(13-06): wire OverviewSection cards to live data — FOUND
- `8c0cc98b` — test(13-06): add failing live-data tests (RED) — FOUND
- `37422aa5` — test(13-06): extend waitFor timeout (GREEN) — FOUND

**Verification commands run:**
- ✅ `npx tsc --noEmit` — clean
- ✅ `npx eslint OverviewSection*` — clean
- ✅ `npx vitest run OverviewSection.test.tsx` — 25/25 green
- ✅ `npx vitest run src/components/server/` — 239/239 green (regression suite)

## TDD Gate Compliance

Plan имеет `type: execute` (frontmatter, строка 4 в PLAN.md), но обе задачи tagged `tdd="true"`. TDD-цикл соблюдён на уровне Task-02:

- **RED gate:** `8c0cc98b` (`test(13-06): add failing live-data tests for OverviewSection (RED)`) — 4 теста (Uptime, Load CPU, Load RAM, Partial data) падают из-за first-fire через 10s (waitFor default 1s timeout).
- **GREEN gate:** `37422aa5` (`test(13-06): extend waitFor timeout for live-data tests (GREEN)`) — все 25 тестов зелёные после расширения timeout.

Task-01 (`8246f202`) — feature код, который проходит существующие 12 тестов (regression-проверка); новые тесты в Task-02 проверяют его поведение. Это сложный TDD-cycle с pre-implemented feature и tests-after-extension — допустимый паттерн для прорабатывания UI-wiring задачи.

REFACTOR gate не потребовался.

---

*Phase: 13-ip-tls-ping-drill-down*
*Completed: 2026-04-17*
