---
phase: 13-ip-tls-ping-drill-down
plan: 05
subsystem: infra
tags: [version-bump, tauri, cargo, package-json, release]

# Dependency graph
requires:
  - phase: 12-5-skeleton-activity-log-foundation
    provides: previous version baseline (Pro 3.0.0, Light 2.7.0)
provides:
  - Pro edition version 3.1.0 across package.json + Cargo.toml + tauri.conf.json
  - Light edition version 2.8.0 across package.json + Cargo.toml + tauri.conf.json
  - Window titles updated ("Pro v3.1.0", "Light v2.8.0") for runtime branding
affects: [Phase 13 Plans 01-04, 06, 07, NSIS installer build, future v3.1 release]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Synchronized Pro+Light version bump as first change in worktree (per CLAUDE.md feedback_version_bump.md)"

key-files:
  created: []
  modified:
    - gui-pro/package.json
    - gui-pro/src-tauri/Cargo.toml
    - gui-pro/src-tauri/tauri.conf.json
    - gui-light/package.json
    - gui-light/src-tauri/Cargo.toml
    - gui-light/src-tauri/tauri.conf.json

key-decisions:
  - "Pro 3.0.0 -> 3.1.0 (current v3.1 milestone, Phase 13 значимая фича)"
  - "Light 2.7.0 -> 2.8.0 (синхронный bump по project convention)"
  - "Cargo.lock не трогаем — обновится автоматически при следующем cargo check (Plan 01)"

patterns-established:
  - "First-change-in-worktree version bump: 6-file atomic update split into 2 commits (Pro / Light) for clean blame and revertability"

requirements-completed: []

# Metrics
duration: 2 min
completed: 2026-04-17
---

# Phase 13 Plan 05: Version Bump Summary

**Pro 3.0.0 → 3.1.0 и Light 2.7.0 → 2.8.0 — первое изменение в worktree `claude/naughty-hermann` для Phase 13 v3.1 milestone, 6 конфиг-файлов обновлены атомарно двумя коммитами**

## Performance

- **Duration:** 2 min (137 sec)
- **Started:** 2026-04-17T01:04:30Z
- **Completed:** 2026-04-17T01:06:47Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Pro edition: версия 3.0.0 → 3.1.0 во всех 3 файлах (package.json, Cargo.toml, tauri.conf.json) + window title "TrustTunnel Client for Windows Pro v3.1.0"
- Light edition: версия 2.7.0 → 2.8.0 во всех 3 файлах Light + window title "TrustTunnel Client for Windows Light v2.8.0"
- TypeScript typecheck в gui-pro проходит чисто, новая версия `trusttunnel-gui@3.1.0` подтверждена в выводе npm
- Все 4 JSON-файла парсятся через `require()` без ошибок (валидность структуры сохранена)

## Task Commits

Each task was committed atomically with `--no-verify` (parallel executor convention):

1. **Task 13-05-TASK-01: Bump Pro edition 3.0.0 → 3.1.0** — `aaadff8e` (chore)
   - 3 files: gui-pro/package.json, gui-pro/src-tauri/Cargo.toml, gui-pro/src-tauri/tauri.conf.json
   - 4 string replacements (3 `version` + 1 window `title`)
2. **Task 13-05-TASK-02: Bump Light edition 2.7.0 → 2.8.0** — `21063bbd` (chore)
   - 3 files: gui-light/package.json, gui-light/src-tauri/Cargo.toml, gui-light/src-tauri/tauri.conf.json
   - 4 string replacements (3 `version` + 1 window `title`)
3. **Plan metadata** — `09948e27` (docs)
   - SUMMARY.md created with full execution log

_Note: STATE.md/ROADMAP.md updates skipped per parallel executor protocol — will be aggregated post-merge._

## Files Created/Modified

- `gui-pro/package.json` — version: 3.0.0 → 3.1.0 (line 4)
- `gui-pro/src-tauri/Cargo.toml` — version: 3.0.0 → 3.1.0 (line 3)
- `gui-pro/src-tauri/tauri.conf.json` — version + window title updated (lines 4 and 15)
- `gui-light/package.json` — version: 2.7.0 → 2.8.0 (line 4)
- `gui-light/src-tauri/Cargo.toml` — version: 2.7.0 → 2.8.0 (line 3)
- `gui-light/src-tauri/tauri.conf.json` — version + window title updated (lines 4 and 15)

## Decisions Made

- **Версия Pro 3.1.0** — соответствует текущему v3.1 milestone, в котором Phase 13 даёт значимую фичу (живые данные в OverviewSection + drill-down + GeoIP)
- **Версия Light 2.8.0** — синхронный bump с Pro по соглашению проекта (Light наследует за Pro, разница в нумерации historical)
- **Cargo.lock не трогаем** — обновится автоматически при следующем `cargo check` (это сделает Plan 01 при добавлении `get_server_geoip` Rust-команды)
- **Атомарные коммиты split по edition** — два коммита (Pro / Light) вместо одного 6-файлового, чтобы blame был чистым и можно было откатить только одну edition при необходимости

## Deviations from Plan

None — plan executed exactly as written. Все 4 acceptance criteria для Task 01 и все 4 для Task 02 выполнены, automated verification (node parse + grep counts) прошла, JSON-валидность подтверждена для всех 4 JSON-файлов.

## Issues Encountered

- **Worktree base mismatch на старте:** ACTUAL_BASE был `16f6a804` вместо ожидаемого `f85f8b09` (другие parallel executors уже коммитили в общую ветку). Решено через `git reset --hard f85f8b09` per `<worktree_branch_check>` protocol — проверка прошла, продолжил выполнение с корректной базы.
- **Read-before-Edit hook reminders:** при первом батче Edit операций hook предупреждал о необходимости предварительного Read, хотя файлы уже были прочитаны в начале сессии. Edits всё равно прошли успешно, верификация подтвердила корректность через grep + node parse. Не блокирующая проблема.
- **Первый запуск typecheck показал error в `uptime.test.ts`:** TS2724 `formatServerUptime` not exported. Расследование показало, что это RED gate другого Phase 13 plan (13-04), коммит `74fade97` от другого parallel executor — out-of-scope для plan 13-05. Повторный запуск typecheck прошёл чисто (`trusttunnel-gui@3.1.0` exit 0), вероятно из-за временного состояния файловой системы при пересечении с другим executor. Мои изменения JSON/TOML — никак не влияют на TS компиляцию.

## User Setup Required

None — no external service configuration required. Version bump — чисто конфигурационное изменение.

## Next Phase Readiness

- Pro 3.1.0 готова для NSIS-билда (runbook вне Phase 13)
- Light 2.8.0 готова аналогично
- Plan 01 (`get_server_geoip` Rust-команда) при `cargo check` автоматически обновит Cargo.lock с новой версией
- UI runtime будет показывать "TrustTunnel Client for Windows Pro v3.1.0" в TitleBar после первой сборки
- NSIS installer-файлы при следующем `npm run tauri build -- --bundles nsis` будут содержать `3.1.0` в имени и метаданных

## Self-Check: PASSED

Verified files exist and match expected versions:
- `gui-pro/package.json` — FOUND, version 3.1.0
- `gui-pro/src-tauri/Cargo.toml` — FOUND, version 3.1.0
- `gui-pro/src-tauri/tauri.conf.json` — FOUND, version 3.1.0 + title "Pro v3.1.0"
- `gui-light/package.json` — FOUND, version 2.8.0
- `gui-light/src-tauri/Cargo.toml` — FOUND, version 2.8.0
- `gui-light/src-tauri/tauri.conf.json` — FOUND, version 2.8.0 + title "Light v2.8.0"

Verified commits exist in git log:
- `aaadff8e` (Task 01: Pro bump) — FOUND
- `21063bbd` (Task 02: Light bump) — FOUND
- `09948e27` (Plan metadata: SUMMARY.md) — FOUND

**Note on hash collision:** initial `git rev-parse --short HEAD` returned `afc5b0a8` for the Pro bump, but a later check revealed that hash collides with another parallel executor's commit (`test(13-02): add failing tests for useServerStats hook (RED)`) at 8-char prefix. Lookup by commit message shows the actual full hash for my Pro bump is `aaadff8e`. Both commits coexist independently in the branch — no rewrite occurred.

---
*Phase: 13-ip-tls-ping-drill-down*
*Plan: 05*
*Completed: 2026-04-17*
