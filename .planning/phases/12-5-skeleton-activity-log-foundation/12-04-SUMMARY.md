---
phase: 12-5-skeleton-activity-log-foundation
plan: "04"
subsystem: activity-log-integration
tags: [activity-log, error-boundary, app-start, tab-switch, disconnect, i18n-fix]
dependency_graph:
  requires: [12-01, 12-02, 12-03]
  provides: [PanelErrorBoundary-download-logs, app.start-log, tab.switch-log, disconnect-logs]
  affects: [PanelErrorBoundary.tsx, App.tsx, ServerTabs.tsx]
tech_stack:
  added: []
  patterns: [fire-and-forget-logging, tauri-invoke-in-class-component, useEffect-app-start]
key_files:
  created: []
  modified:
    - gui-app/src/shared/ui/PanelErrorBoundary.tsx
    - gui-app/src/App.tsx
    - gui-app/src/components/ServerTabs.tsx
decisions:
  - open_logs_folder вместо export_activity_log+open_path — открывает папку logs/ целиком, лучший UX для Windows
  - activityLog в class component через onClick callback, без хуков — invoke напрямую
  - eslint-disable-line для useEffect с activityLog — activityLog стабилен (useCallback с [])
metrics:
  duration: "~15m"
  completed: "2026-04-16"
  tasks: 2
  files: 3
---

# Phase 12 Plan 04: Activity Log Integration + PanelErrorBoundary Summary

Activity Log подключён в 3 точках: App.tsx логирует app.start при монтировании, ServerTabs логирует tab.switch и disconnect события. PanelErrorBoundary получила кнопку "Скачать логи" (open_logs_folder) и исправлен defaultValue anti-pattern в i18n.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | PanelErrorBoundary — кнопка Скачать логи + fix defaultValue | add880ae | PanelErrorBoundary.tsx |
| 2 | Activity Log integration — app.start + tab.switch + disconnect | 7acf2de5 | App.tsx, ServerTabs.tsx |

## Commits

- `add880ae` feat(12-04): PanelErrorBoundary — кнопка Скачать логи + fix defaultValue
- `7acf2de5` feat(12-04): Activity Log integration — app.start + tab.switch + disconnect events

## What Was Built

### Task 1: PanelErrorBoundary

**Изменения в `PanelErrorBoundary.tsx`:**
- Добавлен импорт `Download` из `lucide-react` (дополнение к AlertTriangle/RefreshCw/Home)
- Добавлен импорт `invoke` из `@tauri-apps/api/core`
- Новая кнопка "Скачать логи" (variant="ghost", Download icon) между Retry и На главную
- `onClick` кнопки вызывает `invoke("open_logs_folder")` — открывает папку logs/ в Windows Explorer
- Ошибка вызова логируется в `console.error` (silent fail для UX — fire-and-forget паттерн)
- Исправлен anti-pattern: `t("errors.go_home", { defaultValue: "На главную" })` → `t("errors.go_home")`
- Ключ `errors.go_home` и `errors.download_logs` уже существовали в ru.json/en.json (добавлены в Plan 02)

**Порядок кнопок:** retry (secondary) | download_logs (ghost) | go_home (ghost, только если onNavigateHome передан)

### Task 2: Activity Log Integration

**App.tsx:**
- Импорты: `getVersion` из `@tauri-apps/api/app`, `useActivityLog` из `./shared/hooks/useActivityLog`
- Hook в теле компонента: `const { log: activityLog } = useActivityLog()`
- Новый useEffect с пустым массивом зависимостей — логирует `app.start version=X.Y.Z` при монтировании
- При ошибке getVersion() — логирует `app.start version=unknown`

**ServerTabs.tsx:**
- Импорт `useActivityLog` из `../shared/hooks/useActivityLog`
- Hook в теле компонента: `const { log: activityLog } = useActivityLog()`
- Tab onClick: добавлен `activityLog("USER", \`tab.switch target="${tab.id}"\`, "ServerTabs")`
- LogOut icon onClick: добавлен `activityLog("USER", "server.disconnect.initiated", "ServerTabs.LogOutIcon")`
- ConfirmDialog onConfirm: добавлен `activityLog("USER", "server.disconnect.confirmed", "ConfirmDialog")`
- ConfirmDialog onCancel: добавлен `activityLog("USER", "server.disconnect.cancelled", "ConfirmDialog")`

**Формат логов per D-12:** каждый вызов содержит третий параметр `details` с кодовым именем компонента.

### Task 3: Memory Docs (gitignored — не в git)

- Обновлён `memory/v3/design-system/components.md` — секция PanelErrorBoundary: 3 кнопки, новые i18n ключи, зависимость на invoke
- Создан `memory/v3/control-panel.md` — документация Activity Log точек интеграции (ServerTabs events, App.tsx app.start, PanelErrorBoundary download_logs)

## Deviations from Plan

None — план выполнен точно как написан.

## Known Stubs

None — все интеграционные точки Activity Log реализованы и подключены к реальному Rust бэкенду.

## Threat Surface

Новые вызовы Tauri команд:
- `open_logs_folder` в PanelErrorBoundary — открывает папку текущего пользователя. Покрыто T-12-08 (accept).
- `write_activity_log` через useActivityLog в App.tsx и ServerTabs.tsx — логирует version и tab/disconnect события. Покрыто T-12-09 и T-12-10 (accept/mitigate).

## Self-Check: PASSED

- [x] PanelErrorBoundary.tsx содержит `import { AlertTriangle, RefreshCw, Home, Download }` из lucide-react
- [x] PanelErrorBoundary.tsx содержит `import { invoke } from "@tauri-apps/api/core"`
- [x] PanelErrorBoundary.tsx содержит `invoke("open_logs_folder")`
- [x] PanelErrorBoundary.tsx содержит `{t("errors.download_logs")}`
- [x] PanelErrorBoundary.tsx НЕ содержит `defaultValue: "На главную"`
- [x] App.tsx содержит `import { useActivityLog }` из `./shared/hooks/useActivityLog`
- [x] App.tsx содержит `import { getVersion }` из `@tauri-apps/api/app`
- [x] App.tsx содержит `activityLog("STATE", \`app.start version=` в useEffect
- [x] ServerTabs.tsx содержит `import { useActivityLog }` из `../shared/hooks/useActivityLog`
- [x] ServerTabs.tsx содержит `activityLog("USER", \`tab.switch target=`
- [x] ServerTabs.tsx содержит `activityLog("USER", "server.disconnect.initiated"`
- [x] ServerTabs.tsx содержит `activityLog("USER", "server.disconnect.confirmed"`
- [x] ServerTabs.tsx содержит `activityLog("USER", "server.disconnect.cancelled"`
- [x] Commit add880ae существует
- [x] Commit 7acf2de5 существует
