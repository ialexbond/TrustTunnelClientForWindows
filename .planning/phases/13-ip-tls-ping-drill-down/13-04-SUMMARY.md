---
phase: 13
plan: 04
subsystem: shared/utils + i18n
tags: [tdd, i18n, geoip, uptime, util, prep]
dependency_graph:
  requires:
    - sshErrors block (existing in ru.json/en.json)
    - server.overview block (existing in ru.json/en.json, Phase 12.5)
    - translateSshError switch fallback default (existing)
    - uptime.ts existing formatUptime/formatBytes (Phase 11)
  provides:
    - translateSshError handles GEOIP_TIMEOUT/GEOIP_NO_NETWORK/GEOIP_RATE_LIMITED/GEOIP_INVALID_RESPONSE
    - formatServerUptime(seconds, t) util in uptime.ts
    - geoipErrors.{timeout,noNetwork,rateLimited,invalidResponse} i18n keys (ru, en)
    - server.overview.uptimeFormat.{daysHours,hoursMins,mins} i18n keys (ru, en)
  affects:
    - Plan 06 (OverviewSection live data) — will import formatServerUptime + GEOIP_* mapping
    - Plan 01 (Rust get_server_geoip command) — error codes consumed here
tech-stack:
  added: []  # zero new deps
  patterns:
    - i18n key mirroring (ru ↔ en parity) — preserved across edits
    - Mock T pattern — `(key, params) => params ? key:JSON(params) : key`
    - Switch case before default — chronological "Phase X" comments group cases
key-files:
  created: []  # uptime.ts and uptime.test.ts already existed
  modified:
    - gui-app/src/shared/utils/translateSshError.ts (+15 lines: 4 cases + dev-warn extension)
    - gui-app/src/shared/utils/translateSshError.test.ts (+23 lines: 4 it-blocks)
    - gui-app/src/shared/utils/uptime.ts (+30 lines: TFunction import + formatServerUptime function)
    - gui-app/src/shared/utils/uptime.test.ts (+79 lines: mockT helper + 12 it-blocks)
    - gui-app/src/shared/i18n/locales/ru.json (+11 lines: geoipErrors block + uptimeFormat block)
    - gui-app/src/shared/i18n/locales/en.json (+11 lines: same blocks, English)
decisions:
  - Reuse existing uptime.ts (already had formatUptime/formatBytes) instead of creating new file (Rule 3 deviation — see Deviations section)
  - Append to existing uptime.test.ts (extend, not replace) — preserved existing 12 formatUptime/formatBytes tests
  - Dev-warn extended to surface unknown GEOIP_* codes too (D-08 implementation discretion)
metrics:
  duration: 3m
  completed_date: 2026-04-17
  tasks: 5
  commits: 5
---

# Phase 13 Plan 04: Утилиты-заготовки для OverviewSection live data — Summary

Подготовлены 3 утилиты для будущего Plan 06 (OverviewSection live data): расширен `translateSshError` 4 кодами `GEOIP_*`, добавлен `formatServerUptime(seconds, t)` в существующий `uptime.ts`, обе локали (ru/en) обогащены 7 новыми ключами с mirror-структурой.

## Tasks Completed (5/5)

| # | Name | Commit | Type |
|---|------|--------|------|
| 1 | RED: 4 failing GEOIP_* тесты в translateSshError.test.ts | `c6f6f6a0` | test |
| 2 | GREEN: 4 case GEOIP_* в translateSshError.ts + dev-warn | `fc40419d` | feat |
| 3 | RED: 12 failing formatServerUptime тестов в uptime.test.ts | `74fade97` | test |
| 4 | GREEN: formatServerUptime реализация в uptime.ts | `f2d7a6de` | feat |
| 5 | i18n: geoipErrors + server.overview.uptimeFormat в ru/en | `9738777a` | i18n |

## TDD Gate Compliance

Plan имеет `type: tdd`, последовательность RED → GREEN соблюдена дважды:

**translateSshError track:**
- RED: `c6f6f6a0` (test commit) — 4 GEOIP_* теста падают (`expected ... received raw string`)
- GREEN: `fc40419d` (feat commit) — все 36 тестов зелёные

**formatServerUptime track:**
- RED: `74fade97` (test commit) — 12 тестов падают (`TypeError: formatServerUptime is not a function`)
- GREEN: `f2d7a6de` (feat commit) — все 24 теста зелёные (12 старых + 12 новых)

REFACTOR-фаза не понадобилась — implementation минимальная и чистая.

## Verification Results

```
=== translateSshError ===
 Test Files  1 passed (1)
      Tests  36 passed (36)        ← 32 existing + 4 new GEOIP_*

=== uptime ===
 Test Files  1 passed (1)
      Tests  24 passed (24)        ← 12 existing (formatUptime/formatBytes) + 12 new (formatServerUptime)

=== OverviewSection ===
 Test Files  1 passed (1)
      Tests  12 passed (12)        ← unchanged, i18n keys not broken

TypeScript strict (tsc --noEmit): 0 errors
```

JSON validation:
- `ru.json` parses, contains `geoipErrors.{timeout,noNetwork,rateLimited,invalidResponse}` and `server.overview.uptimeFormat.{daysHours,hoursMins,mins}`
- `en.json` parses, mirror keys present с {{placeholders}} preserved

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Файлы `uptime.ts` и `uptime.test.ts` уже существовали**

- **Found during:** Pre-execution check (ls gui-app/src/shared/utils/)
- **Issue:** План говорил «СОЗДАТЬ новый файл `uptime.ts`», но файл уже существует с двумя ранее реализованными функциями (`formatUptime(since: Date)`, `formatBytes(bytes: number)`) и 12 тестами для них.
- **Fix:** Расширил существующий `uptime.ts` новой функцией `formatServerUptime` (с `import type { TFunction } from "i18next"` сверху). В `uptime.test.ts` добавил отдельный `describe("formatServerUptime", ...)` блок в конец файла, не трогая существующие 12 тестов.
- **Files modified:**
  - `gui-app/src/shared/utils/uptime.ts` (extend, not create)
  - `gui-app/src/shared/utils/uptime.test.ts` (extend, not create)
- **Commits:** `74fade97` (RED), `f2d7a6de` (GREEN)
- **Rationale:** Удаление существующих `formatUptime`/`formatBytes` сломало бы их потребителей (см. в кодовой базе). Расширение — консервативный путь, сохраняющий публичный API.

### Implementation discretion

**dev-warn расширен для GEOIP_*:** В Task 02 план оставил это «на усмотрение planner» (RESEARCH строка 850). Реализовано: `if (DEV && (code.startsWith("SSH_") || code.startsWith("GEOIP_")))` — единый dev-warn покрывает оба префикса. Без этого неизвестные `GEOIP_BLAH` коды от Rust незаметно фолбэкались бы в raw без предупреждения.

## Consumer Dependencies

После завершения этого плана:

1. **Plan 01 (Rust geoip command)** может возвращать ошибки в формате:
   - `Err("GEOIP_TIMEOUT")` → пользователь увидит локализованное сообщение
   - `Err("GEOIP_NO_NETWORK")` → аналогично
   - `Err("GEOIP_RATE_LIMITED")` → аналогично
   - `Err("GEOIP_INVALID_RESPONSE|<detail>")` → детализация подставится в `{{detail}}`

2. **Plan 06 (OverviewSection live data)** может импортировать:
   ```typescript
   import { formatServerUptime } from "../../shared/utils/uptime";
   import { translateSshError } from "../../shared/utils/translateSshError";
   ```
   и использовать для карточек Uptime + Country (live data + error states).

## Requirements Status

- **D-08:** ✅ GEOIP_* error codes mapped — 4 cases + i18n keys ready
- **D-14:** ✅ Each card shows '—' on error — `formatServerUptime` returns "—" для 0/negative/NaN, что подхватит OverviewSection при недоступности stats

## Self-Check: PASSED

**Files exist:**
- `gui-app/src/shared/utils/translateSshError.ts` — FOUND (modified)
- `gui-app/src/shared/utils/translateSshError.test.ts` — FOUND (modified)
- `gui-app/src/shared/utils/uptime.ts` — FOUND (modified, contains `formatServerUptime`)
- `gui-app/src/shared/utils/uptime.test.ts` — FOUND (modified, contains `formatServerUptime` describe)
- `gui-app/src/shared/i18n/locales/ru.json` — FOUND (modified, contains `geoipErrors` + `uptimeFormat`)
- `gui-app/src/shared/i18n/locales/en.json` — FOUND (modified, contains `geoipErrors` + `uptimeFormat`)

**Commits exist (verified via `git log`):**
- `c6f6f6a0` — test(13-04): add failing GEOIP_* tests for translateSshError (RED)
- `fc40419d` — feat(13-04): add GEOIP_* cases to translateSshError (GREEN)
- `74fade97` — test(13-04): add failing formatServerUptime tests (RED)
- `f2d7a6de` — feat(13-04): implement formatServerUptime util (GREEN)
- `9738777a` — i18n(13-04): add geoipErrors + server.overview.uptimeFormat keys
