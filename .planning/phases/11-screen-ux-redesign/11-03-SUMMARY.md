---
phase: 11-screen-ux-redesign
plan: "03"
subsystem: server-tabs
tags: [server-panel, settings-section, service-section, danger-zone, accordion, a11y]
dependency_graph:
  requires: ["11-02"]
  provides: ["ServerSettingsSection", "ServiceSection", "4-tab-complete"]
  affects: ["ServerTabs", "ServerSettingsSection", "ServiceSection", "ServerPanel.test"]
tech_stack:
  added: []
  patterns: ["Accordion wrapping DangerZone", "aria-live polite for diagnostics", "useSecurityState in Settings for SshPortSection", "ConfirmDialog before destructive service action"]
key_files:
  created:
    - gui-app/src/components/server/ServerSettingsSection.tsx
    - gui-app/src/components/server/ServiceSection.tsx
  modified:
    - gui-app/src/components/ServerTabs.tsx
    - gui-app/src/components/ServerPanel.test.tsx
decisions:
  - "ServerSettingsSection instantiates own useSecurityState for SshPortSection (SecuritySection stays self-contained per Pitfall 4)"
  - "ServiceSection wraps SecuritySection as <SecuritySection state={state} /> preserving its internal hook"
  - "ConfirmDialog before stop-service — T-11-03 elevation guard — separate from DangerZone reboot confirm in ServerPanel"
  - "vpn.toml shown as raw <pre> block inside Advanced accordion (DC-07 — dev tool hidden)"
  - "BBR uses Toggle shared component (not custom button) for design-system consistency"
metrics:
  duration: "~30 min"
  completed: "2026-04-15"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 2
---

# Phase 11 Plan 03: ServerSettingsSection + ServiceSection Summary

ServerSettingsSection и ServiceSection созданы и подключены в ServerTabs — все 4 таба серверной панели теперь рендерят реальный контент вместо placeholder'ов. Settings консолидирует feature toggles, BBR, SSH port change, Advanced accordion (version + vpn.toml + MTProto). Service консолидирует restart/stop/start controls, security diagnostics, logs, DangerZone accordion.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create ServerSettingsSection + ServiceSection | `078d8997` | ServerSettingsSection.tsx (new, ~360 lines), ServiceSection.tsx (new, ~138 lines) |
| 2 | Wire new sections into ServerTabs (replace placeholders) | `9badec0c` | ServerTabs.tsx (+2 imports, -2 placeholders), ServerPanel.test.tsx (+4 vi.mock) |

## What Was Built

### Task 1: ServerSettingsSection.tsx

**Block 1 — Feature Toggles (Card + SlidersHorizontal icon):**
- `handleToggleFeature` с `localOverrides` Map и `activeTogglesRef` — точная копия паттерна из ConfigSection
- `featureItems`: ping_enable, speedtest_enable, ipv6_available с описаниями
- Кастомный toggle button (анимация left: 2→20px, spin spinner при загрузке)
- Заголовок: `t("server.config.toggles_title")` = "Параметры сервера"

**Block 2 — Network (Card + Network icon):**
- `useBbrState` хук → `Toggle` shared component (BBR TCP-оптимизация)
- `useSecurityState` → `SshPortSection` (изменение SSH порта)
- Заголовок: `t("server.config.network_title")` = "Сеть"

**Block 3 — Advanced Accordion (collapsed by default):**
- `VersionSection state={state}` — обновление версии сервера
- Raw `configRaw` в `<pre>` блоке (vpn.toml)
- `MtProtoSection` при наличии `mtproto.status`
- `Accordion defaultOpen={[]}` с заголовком `t("server.config.advanced")` = "Дополнительно"

**Save CTA:**
- `Button variant="primary"` → `t("server.config.save_settings")` → `invoke("server_apply_config", sshParams)`
- ConfirmDialog перед сохранением

### Task 2: ServiceSection.tsx

**Block 1 — Service Controls (Card + RefreshCw icon):**
- Restart: `Button variant="ghost"` + `runAction("restart", ...)` (всегда доступен)
- Stop: `Button variant="danger-outline"` → ConfirmDialog (T-11-03 elevation guard) → `runAction("stop", ...)`
- Start: `Button variant="primary"` (только при `!serviceActive`)
- Заголовок: `t("server.service.controls_title")` = "Управление сервисом"

**Block 2 — Security Diagnostics:**
- `<div aria-live="polite">` wrapper (R-02 WCAG fix)
- `<SecuritySection state={state} />` — самодостаточный компонент с внутренним `useSecurityState`

**Block 3 — Logs:**
- `<LogsSection state={state} />` — самодостаточный компонент

**Block 4 — DangerZone Accordion (collapsed by default):**
- `Accordion defaultOpen={[]}` с заголовком в красном цвете + AlertTriangle иконка
- `<DangerZoneSection state={state} />` внутри

### Task 2: ServerTabs.tsx + ServerPanel.test.tsx

**ServerTabs.tsx:**
- `import { ServerSettingsSection }` + `import { ServiceSection }`
- Settings panel: `<ServerSettingsSection state={state} />` вместо placeholder div
- Service panel: `<ServiceSection state={state} />` вместо placeholder div

**ServerPanel.test.tsx (Rule 1 - Bug fix):**
- Добавлены `vi.mock("./server/ServerSettingsSection")` и `vi.mock("./server/ServiceSection")`
- Без моков `VersionSection.availableVersions.filter` падал с `Cannot read properties of undefined` — мок-стейт не содержит `availableVersions`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ServerPanel.test.tsx падал из-за отсутствия моков новых секций**
- **Found during:** Task 2 verification (vitest run)
- **Issue:** ServerSettingsSection рендерит VersionSection, который вызывает `availableVersions.filter()` — мок-стейт в тесте не содержал `availableVersions`, TypeError при рендере
- **Fix:** Добавлены 4 `vi.mock` (ServerSettingsSection, ServiceSection) в ServerPanel.test.tsx — аналогично существующим mockам OverviewSection/UsersSection
- **Files modified:** `gui-app/src/components/ServerPanel.test.tsx`
- **Commit:** `9badec0c`

## Known Stubs

Нет — все placeholder'ы из Plan 02 заменены реальным контентом:
- "Settings loading..." → `<ServerSettingsSection state={state} />`
- "Service loading..." → `<ServiceSection state={state} />`

Пункт из Known Stubs Plan 02 `protocolValue` fallback в OverviewSection остаётся — он не входит в скоуп Plan 03.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| T-11-03 resolved | ServiceSection.tsx | ConfirmDialog перед stop-service реализован — elevation guard на месте |

Новых threat surface нет — используются только существующие IPC-команды (server_restart_service, server_stop_service, server_start_service, server_apply_config), уже использованные в ServerStatusSection.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| ServerSettingsSection.tsx created | FOUND |
| ServiceSection.tsx created | FOUND |
| ServerTabs.tsx updated (imports + renders) | FOUND |
| ServerPanel.test.tsx updated (vi.mock) | FOUND |
| commit 078d8997 (components) | FOUND |
| commit 9badec0c (wiring + test fix) | FOUND |
| Accordion in ServerSettingsSection | FOUND |
| useBbrState in ServerSettingsSection | FOUND |
| SshPortSection in ServerSettingsSection | FOUND |
| VersionSection in ServerSettingsSection | FOUND |
| DangerZoneSection in ServiceSection | FOUND |
| SecuritySection in ServiceSection | FOUND |
| LogsSection in ServiceSection | FOUND |
| ConfirmDialog in ServiceSection | FOUND |
| aria-live in ServiceSection | FOUND |
| server.config.save_settings in ServerSettingsSection | FOUND |
| No placeholders in ServerTabs | CONFIRMED (0 matches) |
| No old section imports in ServerTabs | CONFIRMED (0 matches) |
| TypeScript: 0 errors in new files | CONFIRMED |
| Tests: 98 passed, 0 failed | CONFIRMED |
