---
phase: 13-ip-tls-ping-drill-down
plan: 03
subsystem: ui
tags: [react, hook, localstorage, geoip, cache, ttl, tdd]

# Dependency graph
requires:
  - phase: 13-ip-tls-ping-drill-down
    provides: "Plan 01: Rust команда get_server_geoip(host) → GeoIpInfo через ipwho.is"
provides:
  - "useServerGeoIp(sshParams) — fire-once React hook для GeoIP lookup"
  - "localStorage cache pattern с 30-дневным TTL и валидацией fetched_at"
  - "GeoIpInfo TypeScript type, зеркало Rust struct"
affects: [Plan 06 — OverviewSection использует useServerGeoIp для карточки «Страна»]

# Tech tracking
tech-stack:
  added: []  # Никаких новых библиотек, только реакт-хук
  patterns:
    - "fire-once invoke + lazy useState rehydrate (analog: useMtProtoState)"
    - "TTL-aware cache: fetched_at ISO + Date.now() сравнение + auto-removeItem на expired"
    - "race-safe useEffect: cancelled flag в then/catch/finally"
    - "void Promise.resolve() обходит react-hooks/set-state-in-effect для сync cache lookup"

key-files:
  created:
    - "gui-app/src/components/server/useServerGeoIp.ts"
    - "gui-app/src/components/server/useServerGeoIp.test.ts"
  modified: []

key-decisions:
  - "STORAGE_PREFIX = \"tt_geoip_\" точно по D-06 (не tt_geoip_cache_ или mtproto-style)"
  - "TTL ровно 30 дней (30 * 24 * 60 * 60 * 1000 ms) — страна сервера не меняется"
  - "Expired или corrupt JSON → одинаково: localStorage.removeItem + null → invoke (Pitfall 5)"
  - "При ошибке invoke не блокируем UI: geo=null, error=String(e); карточка покажет — (D-14)"
  - "Cache lookup в effect через void Promise.resolve() — обход react-hooks/set-state-in-effect без подавления правила"

patterns-established:
  - "TTL cache helper: проверка age + auto-evict на load — переиспользуемо для будущих 30d-кешей"
  - "Async-shifted cache rehydrate: микротаска вместо sync setState в effect — резолвится до paint"

requirements-completed: [D-06, D-14, D-16, D-20]

# Metrics
duration: 4min
completed: 2026-04-17
---

# Phase 13 Plan 03: useServerGeoIp Hook Summary

**Fire-once React hook для GeoIP lookup через invoke + 30-дневный localStorage cache с TTL — единственный источник данных для карточки «Страна» в OverviewSection.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-17T01:04:11Z
- **Completed:** 2026-04-17T01:07:28Z
- **Tasks:** 2/2
- **Files created:** 2 (1 hook + 1 test)
- **Files modified:** 0

## Accomplishments

- Реализован `useServerGeoIp({ host })` с сигнатурой `{ geo, loading, error }` точно по D-16
- 30-дневный TTL-кеш в localStorage с ключом `tt_geoip_{host}` (D-06) — cache hit / miss / expired автоматически различаются
- Полный TDD-цикл RED → GREEN: 5 тестов написаны до реализации, упали из-за отсутствующего модуля, затем реализация прошла все 5
- Покрытие edge cases: corrupt JSON в localStorage (Pitfall 5), expired cache (>30d), invoke error (D-14 partial data)
- `npm run lint` (`react-hooks/set-state-in-effect`) прошёл без подавления правил — паттерн async-shifted cache rehydrate

## Task Commits

Each task was committed atomically:

1. **Task 13-03-TASK-01: useServerGeoIp.test.ts (RED)** — `e793c06a` (test)
2. **Task 13-03-TASK-02: useServerGeoIp.ts (GREEN)** — `e45bf7f8` (feat)

_Note: TDD plan — test commit предшествует feat-коммиту в git log (RED → GREEN gate compliance)._

## Files Created/Modified

### Created
- **`gui-app/src/components/server/useServerGeoIp.ts`** (128 строк) — React hook + cache helpers + GeoIpInfo type
- **`gui-app/src/components/server/useServerGeoIp.test.ts`** (132 строки) — 5 unit-тестов с mockInvoke и localStorage

### Modified
None.

## Decisions Made

### D-06: точный ключ `tt_geoip_{host}`, TTL 30 дней
Phase 13 CONTEXT уже зафиксировал ключ и TTL. Реализация содержит обе константы:
```typescript
const STORAGE_PREFIX = "tt_geoip_";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
```

### Корректная обработка expired cache
В `loadCache` после `JSON.parse` проверяется age:
```typescript
const age = Date.now() - new Date(parsed.fetched_at).getTime();
if (Number.isNaN(age) || age > TTL_MS) {
  localStorage.removeItem(getCacheKey(host));
  return null;
}
```
- `Number.isNaN(age)` ловит сломанные `fetched_at` (например, `"not-a-date"`)
- Проактивный `removeItem` — не оставляем мусор в хранилище после expiration

### Async-shifted setState в effect (Rule 1 — auto-fix lint error)
Проектное правило `react-hooks/set-state-in-effect` (включено в `eslint.config.js` через `reactHooks.configs.recommended`) запрещает синхронный `setState` в теле `useEffect`. Решение — обернуть cache lookup в микротаску:
```typescript
useEffect(() => {
  let cancelled = false;
  void Promise.resolve().then(() => {
    if (cancelled) return;
    const cached = loadCache(host);
    if (cached) { setGeo(cached); setLoading(false); ... }
    else { invoke<GeoIpInfo>("get_server_geoip", { host })... }
  });
  return () => { cancelled = true; };
}, [host]);
```
Микротаска резолвится до paint, для пользователя визуально неотличимо от sync. Альтернатива — eslint-disable — отвергнута, потому что репо требует `--max-warnings 0` (CLAUDE.md prerelease check).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] react-hooks/set-state-in-effect violation в первоначальной реализации**
- **Found during:** Task 13-03-TASK-02 (после `npm run lint`)
- **Issue:** Реализация по шаблону плана вызывала `setGeo(cached)` синхронно в теле useEffect при cache hit. Правило `react-hooks/set-state-in-effect` (recommended preset) это запрещает; репозиторий блокирует prerelease на любом ESLint warning (`--max-warnings 0`).
- **Fix:** Cache lookup и весь invoke-блок обёрнуты в `void Promise.resolve().then(...)`. Cancelled-flag дублируется внутри callback для race-safe cleanup на смене host. Тесты не пострадали (`vi.waitFor` в тесте cache hit ждёт стабилизации; внутри теста синхронный `expect(geo).toEqual(mockGeo)` после первого render по-прежнему работает за счёт lazy initializer `useState(() => loadCache(host))`).
- **Files modified:** `gui-app/src/components/server/useServerGeoIp.ts`
- **Verification:** `npx eslint ... --max-warnings 0` → clean; `npx vitest run ...` → 5/5 зелёных; `npx tsc --noEmit` → clean.
- **Committed in:** `e45bf7f8` (часть task-02 commit, до фиксации проверено что lint падает на исходной версии).

## TDD Gate Compliance

- **RED gate:** `e793c06a` — `test(13-03): add failing tests for useServerGeoIp hook (TDD RED)` — тесты упали с `Failed to resolve import "./useServerGeoIp"`.
- **GREEN gate:** `e45bf7f8` — `feat(13-03): implement useServerGeoIp hook (TDD GREEN)` — все 5 тестов прошли.
- **REFACTOR gate:** не потребовалось (Rule-1 fix применён до зелёного коммита, в самом GREEN-коммите).

Sequence: test → feat. Корректно.

## Verification Results

- `npx vitest run src/components/server/useServerGeoIp.test.ts` → **5/5 passed** (cache hit, cache miss, cache expired, invoke error, corrupt JSON)
- `npx tsc --noEmit` → clean (TypeScript strict mode)
- `npx eslint useServerGeoIp.ts useServerGeoIp.test.ts --max-warnings 0` → clean

## Consumer Dependency

Plan 06 (OverviewSection wire live data + drill-down) будет вызывать:
```typescript
const { geo, loading } = useServerGeoIp({ host: state.host });
```
И рендерить:
```tsx
{geo ? `${geo.flag_emoji} ${geo.country}` : loading ? <Skeleton/> : "—"}
```

## Threat Flags

Нет новых threat surface — hook только читает localStorage + вызывает invoke (Rust команда из Plan 01 уже прошла threat review).

## Self-Check: PASSED

**Files exist:**
- `gui-app/src/components/server/useServerGeoIp.ts` — FOUND
- `gui-app/src/components/server/useServerGeoIp.test.ts` — FOUND

**Commits exist:**
- `e793c06a` (test, RED) — FOUND
- `e45bf7f8` (feat, GREEN) — FOUND
