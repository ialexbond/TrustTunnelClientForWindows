---
phase: 11-screen-ux-redesign
plan: "02"
subsystem: server-tabs
tags: [server-panel, i18n, tab-structure, overview-section, cross-fade]
dependency_graph:
  requires: ["11-01"]
  provides: ["4-tab-server-navigation", "OverviewSection"]
  affects: ["ServerTabs", "ServerPanel", "OverviewSection"]
tech_stack:
  added: []
  patterns: ["cross-fade visibility+opacity", "StatCard 2x2 grid", "CertSection sub-component"]
key_files:
  created:
    - gui-app/src/components/server/OverviewSection.tsx
  modified:
    - gui-app/src/components/ServerTabs.tsx
    - gui-app/src/components/ServerPanel.test.tsx
    - gui-app/src/shared/i18n/locales/ru.json
    - gui-app/src/shared/i18n/locales/en.json
decisions:
  - "OverviewSection imports CertSection as sub-component — no inlining of handleRenew/loadCert logic (Pitfall 3)"
  - "IP address removed from status row in OverviewSection — only in ServerTabs header (DC-03)"
  - "Danger buttons absent from Overview — moved to Service tab in Plan 03 (DC-01)"
  - "Settings/Service tabs render placeholder text pending Plan 03"
  - "ProcessFilterSection test failures are pre-existing (confirmed via git stash), deferred"
metrics:
  duration: "~45 min"
  completed: "2026-04-15"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 4
---

# Phase 11 Plan 02: ServerTabs 4-tab restructure + OverviewSection Summary

4-табовая структура серверной панели управления с новым компонентом OverviewSection, объединяющим статус сервера + StatCard-сетку метрик + TLS-сертификат.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add all new i18n keys for 4-tab structure | `1ecae00a` | ru.json, en.json (+76 строк) |
| 2 | Rewrite ServerTabs 5->4 tabs + create OverviewSection | `11abcd24` | ServerTabs.tsx, OverviewSection.tsx (new), ServerPanel.test.tsx |

## What Was Built

### Task 1: i18n Keys (76 additions)

Новые ключи в ru.json и en.json:

- `tabs.overview`, `tabs.settings_server`, `tabs.service` — названия новых табов
- `server.overview.*` — 4 метрики для StatCard (version, protocol, port, users)
- `server.service.controls_title` — заголовок секции управления
- `server.config.toggles_title/network_title/advanced/save_settings` — для будущей Settings секции
- `server.cert.valid_days/expiring_days/auto_renewal` — доп. ключи сертификата
- `server.danger.stop_title/stop_message/reboot_title/reboot_message/delete_title/delete_message`
- `server.security.load_error`, `server.status.refresh_aria`
- `server.users.empty_heading/empty_body`, `users.actions_menu`
- Старые `tabs.config/security/tools` сохранены для обратной совместимости

### Task 2: ServerTabs + OverviewSection

**ServerTabs.tsx** — полная перезапись:
- `type TabId = "overview" | "users" | "settings" | "service"` — 4 таба вместо 5
- Новые иконки: `LayoutDashboard`, `SlidersHorizontal`, `Terminal`
- Default tab: `"overview"` вместо `"status"`
- `focus-visible:shadow-[var(--focus-ring)]` на кнопках табов (O-01 a11y fix)
- `mx-1` вместо `mx-0.5` (4px spacing)
- Settings/Service: placeholder `<div>` до Plan 03
- Убраны импорты 8 старых секций (ServerStatusSection, VersionSection, ConfigSection и т.д.)

**OverviewSection.tsx** — новый компонент (163 строки):
- **Block 1**: Card со статусом — `StatusIndicator` (success/danger + pulse) вместо raw div, текст Running/Stopped, `IconButton h-9 w-9` для refresh (O-05 fix 36px), ping Badge
- **Block 2**: `grid grid-cols-2 gap-4` из 4 StatCard (version/protocol/port/users)
- **Block 3**: `<CertSection state={state} />` как sub-component
- IP адрес убран из строки статуса (DC-03 fix)
- Кнопки danger/stop/reboot/start убраны (DC-01 fix)
- Rebooting state с countdown сохранён

**ServerPanel.test.tsx** — обновлён под 4-табовую структуру:
- Моки старых компонентов заменены на `OverviewSection` mock
- Тест "renders all server sections" переписан на проверку 4 кнопок + overview/users testId

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ServerPanel.test.tsx сломан из-за рефакторинга**
- **Found during:** Task 2 verification
- **Issue:** Тест искал data-testid старых компонентов (server-status-section, version-section, config-section, logs-section, danger-zone-section), которые больше не рендерятся в ServerTabs
- **Fix:** Обновлены vi.mock() — убраны моки 5 старых компонентов, добавлен mock OverviewSection. Тест переписан на проверку 4 табов и новых testId
- **Files modified:** gui-app/src/components/ServerPanel.test.tsx
- **Commit:** `11abcd24`

**2. [Rule 3 - Blocking] node_modules отсутствовали в worktree**
- **Found during:** Task 2 verification (typecheck)
- **Issue:** В worktree нет node_modules, tsc недоступен
- **Fix:** `npm install --legacy-peer-deps` (согласно CLAUDE.md worktree setup)
- **Impact:** Нет — установка пакетов, не кодовые изменения

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| "Settings loading..." | ServerTabs.tsx | ~120 | Placeholder до Plan 03 (ServerSettingsSection) |
| "Service loading..." | ServerTabs.tsx | ~135 | Placeholder до Plan 03 (ServiceSection) |
| `protocolValue` fallback "WireGuard" | OverviewSection.tsx | ~109 | ServerInfo не содержит поля protocol/listenPort — нужно добавить в useServerState или parse из configRaw в Plan 03 |

## Deferred Issues

**ProcessFilterSection.test.tsx** — 2-3 теста флейково падают при полном прогоне suite (race condition с async):
- `calls onLoadProcesses and opens picker on add click`
- `picker modal opens and shows available processes`
- Подтверждено как pre-existing: тест падал ДО наших изменений (проверено через git stash)
- Не относится к изменениям Plan 02 — вынесено в deferred

## Threat Flags

Нет новых threat surface — OverviewSection читает только уже существующие данные через useServerState.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| OverviewSection.tsx created | FOUND |
| ServerTabs.tsx modified | FOUND |
| 11-02-SUMMARY.md created | FOUND |
| commit 1ecae00a (i18n) | FOUND |
| commit 11abcd24 (ServerTabs+OverviewSection) | FOUND |
