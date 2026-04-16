---
phase: 12-5-skeleton-activity-log-foundation
plan: "02"
subsystem: server-panel
tags: [server-tabs, i18n, disconnect, confirm-dialog, skeleton]
dependency_graph:
  requires: []
  provides: [5-tab-server-panel, disconnect-icon-with-confirm, updated-skeleton]
  affects: [ServerTabs.tsx, ControlPanelPage.tsx]
tech_stack:
  added: []
  patterns: [cross-fade-visibility-opacity, confirm-dialog-pattern]
key_files:
  created: []
  modified:
    - gui-app/src/components/ServerTabs.tsx
    - gui-app/src/components/ControlPanelPage.tsx
    - gui-app/src/shared/i18n/locales/ru.json
    - gui-app/src/shared/i18n/locales/en.json
decisions:
  - security/utilities tabs use placeholder divs — Plan 03 will replace with real sections
  - server.config.port_title added to existing config section rather than creating new disconnect-only object
  - ServiceSection import removed from ServerTabs (no longer referenced)
metrics:
  duration: "~12m"
  completed: "2026-04-16"
  tasks: 2
  files: 4
---

# Phase 12 Plan 02: ServerTabs 4->5 + Header Removal + Disconnect Icon Summary

ServerTabs перестроен с 4 на 5 табов (overview/users/configuration/security/utilities), хедер с IP-адресом удалён полностью, disconnect вынесен в иконку LogOut с ConfirmDialog. ServerPanelSkeleton обновлён под новую структуру.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | i18n keys для табов и disconnect | 178386f4 | ru.json, en.json |
| 2 | ServerTabs 4->5 + header removal + disconnect icon + ControlPanelPage skeleton | 027826c0 | ServerTabs.tsx, ControlPanelPage.tsx |

## Commits

- `178386f4` feat(12-02): add i18n keys for 5-tab server panel and disconnect dialog
- `027826c0` feat(12-02): ServerTabs 4->5 tabs, remove header, add disconnect icon + ConfirmDialog

## What Was Built

### Task 1: i18n Keys

Added 8 new/updated keys to both `ru.json` and `en.json`:
- `tabs.configuration` / `tabs.utilities` — новые табы
- `control.disconnect` — обновлено с "Сменить сервер" на "Отключиться от сервера"
- `server.disconnect.confirm_title` / `server.disconnect.confirm_message` — для ConfirmDialog
- `server.config.port_title` — SSH Port label
- `errors.download_logs` / `errors.go_home` — для PanelErrorBoundary

Deprecated ключи `tabs.settings_server` и `tabs.service` сохранены для backward compatibility.

### Task 2: ServerTabs Rewrite

**TabId обновлён:**
```typescript
type TabId = "overview" | "users" | "configuration" | "security" | "utilities";
```

**Изменения:**
- Хедер с `state.host` и inline disconnect button полностью удалён
- Массив tabs обновлён: `Terminal` → `Wrench`, `Shield` добавлен, `settings` → `configuration`, `service` → `security`/`utilities`
- LogOut иконка с `border-l` разделителем справа от табов (`aria-label`, `title`, `focus-visible` ring)
- ConfirmDialog `variant="danger"` открывается по клику LogOut, подтверждение вызывает `state.onDisconnect()`
- 5 cross-fade панелей (visibility+opacity): overview/users/configuration работают, security/utilities — placeholder до Plan 03
- `ServiceSection` import удалён из ServerTabs

**ServerPanelSkeleton обновлён:**
- Удалён header skeleton (address bar + disconnect button)
- Добавлен placeholder skeleton для иконки disconnect (`width={36}`)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

| Stub | File | Reason |
|------|------|--------|
| `<div>Security tab (Plan 03)</div>` | ServerTabs.tsx | Временный placeholder — Plan 03 создаст SecurityTabSection |
| `<div>Utilities tab (Plan 03)</div>` | ServerTabs.tsx | Временный placeholder — Plan 03 создаст UtilitiesTabSection |

These stubs are intentional per the plan. Plan 03 will replace them with real sections.

## Verification

- TypeScript typecheck: no errors in modified files (ServerTabs.tsx, ControlPanelPage.tsx)
- Pre-existing typecheck errors in unrelated files (App.tsx, wizard components, shared/ui) are out of scope
- i18n keys verified with node -e check: ALL KEYS OK
- Structural checks: TabId has 5 values, state.host absent, LogOut icon present, ConfirmDialog present, 5 cross-fade panels with aria-hidden

## Threat Surface

No new security-relevant surface introduced. ConfirmDialog uses existing Modal with focus trap. `showDisconnectConfirm` is local UI state with no security impact (per plan threat model T-12-05).

## Self-Check: PASSED

- [x] ServerTabs.tsx exists and modified
- [x] ControlPanelPage.tsx exists and modified
- [x] ru.json updated with 8 keys
- [x] en.json updated with 8 keys
- [x] Commit 178386f4 exists
- [x] Commit 027826c0 exists
