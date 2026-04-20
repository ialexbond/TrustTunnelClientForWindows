---
phase: 12-5-skeleton-activity-log-foundation
plan: "03"
subsystem: server-panel
tags: [security-tab, utilities-tab, server-tabs, bbr, mtproto, service-controls]
dependency_graph:
  requires: [12-02]
  provides: [SecurityTabSection, UtilitiesTabSection, cleaned-ServerSettingsSection, 5-functional-tabs]
  affects: [ServerTabs.tsx, ServerSettingsSection.tsx]
tech_stack:
  added: []
  patterns: [cross-fade-visibility-opacity, confirm-dialog-pattern, aria-live-polite]
key_files:
  created:
    - gui-pro/src/components/server/SecurityTabSection.tsx
    - gui-pro/src/components/server/UtilitiesTabSection.tsx
  modified:
    - gui-pro/src/components/server/ServerSettingsSection.tsx
    - gui-pro/src/components/ServerTabs.tsx
decisions:
  - SecurityTabSection is a thin wrapper (no own state) — SecuritySection manages its own useSecurityState internally
  - UtilitiesTabSection owns useBbrState + useMtProtoState hooks (data consumers, not ServerState props)
  - ServiceSection.tsx kept intact — not deleted, may be used in tests/Storybook
  - ServerSettingsSection keeps useSecurityState for SshPortSection (two instances OK — each makes own SSH request)
  - BBR card in UtilitiesTabSection uses server.utilities.bbr.* keys (matching existing ServerSettingsSection usage)
metrics:
  duration: "~18m"
  completed: "2026-04-16"
  tasks: 2
  files: 4
---

# Phase 12 Plan 03: SecurityTabSection + UtilitiesTabSection Migration Summary

SecurityTabSection и UtilitiesTabSection созданы с полным содержимым. ServerSettingsSection очищен от BBR/MTProto. ServerTabs подключает реальные компоненты вместо placeholder div'ов — все 5 табов полностью функциональны.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | SecurityTabSection + UtilitiesTabSection | 463343ae | SecurityTabSection.tsx, UtilitiesTabSection.tsx |
| 2 | ServerSettingsSection cleanup + ServerTabs wire-up | c66a2a1c | ServerSettingsSection.tsx, ServerTabs.tsx |

## Commits

- `463343ae` feat(12-03): create SecurityTabSection and UtilitiesTabSection
- `c66a2a1c` feat(12-03): cleanup ServerSettingsSection + wire SecurityTabSection/UtilitiesTabSection in ServerTabs

## What Was Built

### Task 1: SecurityTabSection + UtilitiesTabSection

**SecurityTabSection.tsx** — тонкий wrapper без собственного state:
- `<div aria-live="polite"><SecuritySection state={state} /></div>` — screen reader объявляет SSH-результаты
- `<CertSection state={state} />` — информация о сертификате
- SecuritySection управляет собственным `useSecurityState` внутри

**UtilitiesTabSection.tsx** — полноценный компонент с 5 блоками:
1. **Service Controls** (Card) — Restart/Stop/Start кнопки с ConfirmDialog для Stop (T-12-06 elevation guard)
2. **BBR Toggle** (Card) — `useBbrState` hook, Toggle с иконкой Zap, `server.utilities.bbr.*` i18n ключи
3. **MTProto** — `useMtProtoState` hook, условный рендер `{mtproto.status && <MtProtoSection>}`, отдельный ConfirmDialog для uninstall
4. **LogsSection** — перенесено из ServiceSection
5. **DangerZone Accordion** — закрыт по умолчанию (T-12-07), `<DangerZoneSection>` внутри

### Task 2: ServerSettingsSection cleanup + ServerTabs wire-up

**ServerSettingsSection.tsx** — очищен:
- Удалены импорты: `useBbrState`, `useMtProtoState`, `MtProtoSection`, `Zap`
- Удалены hook-вызовы: `const bbr = ...`, `const mtproto = ...`
- Block 2 (Network card): BBR Toggle удалён, заголовок `server.config.port_title`, остался только `<SshPortSection>`
- Block 3 (Advanced Accordion): удалён `<MtProtoSection>` и его `<ConfirmDialog>`
- `useSecurityState` сохранён — нужен для `SshPortSection`

**ServerTabs.tsx** — wire-up новых компонентов:
- Добавлены импорты `SecurityTabSection` и `UtilitiesTabSection`
- Placeholder `<div>Security tab (Plan 03)</div>` → `<SecurityTabSection state={state} />`
- Placeholder `<div>Utilities tab (Plan 03)</div>` → `<UtilitiesTabSection state={state} />`
- `ServiceSection` не импортируется

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — все 5 табов полностью функциональны с реальными компонентами.

## Threat Surface

No new security-relevant surface introduced. Threat mitigations from plan:
- T-12-06: ConfirmDialog для Stop service перенесён из ServiceSection as-is (elevation guard сохранён)
- T-12-07: DangerZone в Accordion (closed by default) с ConfirmDialog — перенесено из ServiceSection as-is

## Self-Check: PASSED

- [x] SecurityTabSection.tsx exists: `gui-pro/src/components/server/SecurityTabSection.tsx`
- [x] UtilitiesTabSection.tsx exists: `gui-pro/src/components/server/UtilitiesTabSection.tsx`
- [x] ServerSettingsSection.tsx does NOT contain useBbrState/useMtProtoState/MtProtoSection
- [x] ServerSettingsSection.tsx contains server.config.port_title
- [x] ServerSettingsSection.tsx contains useSecurityState
- [x] ServerTabs.tsx contains SecurityTabSection + UtilitiesTabSection imports and renders
- [x] ServerTabs.tsx does NOT contain ServiceSection import
- [x] No TypeScript errors in modified/created files
- [x] Commit 463343ae exists
- [x] Commit c66a2a1c exists
