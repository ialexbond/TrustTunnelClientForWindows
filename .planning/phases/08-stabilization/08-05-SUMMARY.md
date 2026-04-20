---
phase: 08-stabilization
plan: "05"
subsystem: ui-polish
tags: [ui, a11y, design-tokens, pill-tabs, keyboard-accessibility]
dependency_graph:
  requires: [08-01]
  provides: [pill-tab-indicator, disconnect-a11y, shadow-xs-token, auth-button-contrast]
  affects:
    - gui-pro/src/components/ServerTabs.tsx
    - gui-pro/src/components/StatusPanel.tsx
    - gui-pro/src/components/layout/TabNavigation.tsx
    - gui-pro/src/components/server/SshConnectForm.tsx
    - gui-pro/src/shared/styles/tokens.css
tech_stack:
  added: []
  patterns:
    - pill-tab-indicator (rounded-md bg-elevated + shadow-xs, no border-b)
    - focus-visible ring on disconnect buttons via CSS box-shadow
    - --shadow-xs token for subtle elevation (dark: 0.20 opacity, light: 0.04 opacity)
key_files:
  created: []
  modified:
    - gui-pro/src/components/ServerTabs.tsx
    - gui-pro/src/components/StatusPanel.tsx
    - gui-pro/src/components/layout/TabNavigation.tsx
    - gui-pro/src/components/server/SshConnectForm.tsx
    - gui-pro/src/shared/styles/tokens.css
decisions:
  - "D-18: pill indicator — bg-[var(--color-bg-elevated)] + shadow-xs вместо border-b underline"
  - "D-15: maxWidth:120 вместо width:120 — вкладки сжимаются, не растягиваются на широких окнах"
  - "STAB-09: focus-visible:shadow-[var(--focus-ring)] + outline-none на disconnect button в ServerTabs; aria-label на обоих disconnect"
  - "D-17: bg-[var(--color-input-bg)] вместо bg-[var(--color-bg-secondary)] для inactive auth segment"
  - "D-16: --shadow-xs добавлен в оба блока dark/light темы tokens.css"
  - "D-14/D-19: изменений не требовалось — display:flex|none уже обрабатывает layout shift, ServerSidebar не используется"
metrics:
  duration: "~7 min"
  completed: "2026-04-15T10:20:30Z"
  tasks_completed: 2
  files_modified: 5
---

# Phase 8 Plan 05: UI fixes (D-14–D-19) + keyboard accessibility (STAB-09) Summary

**One-liner:** Pill-индикатор ServerTabs, focus-visible ring на disconnect, aria-label доступность, auth-кнопки с контрастом на светлой теме, токен --shadow-xs для мягкой тени.

## What Was Built

Шесть UI-фиксов и одно улучшение доступности из бэклога Phase 8:

### D-18: ServerTabs pill indicator

`ServerTabs.tsx` — таб-бар сервера переработан с underline-индикатора на pill-стиль:
- Убраны `border-b -mb-px` классы с кнопок вкладок
- Активный таб: `bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] shadow-[var(--shadow-xs)]` + `rounded-[var(--radius-md)]`
- Неактивный таб: `hover:bg-[var(--color-bg-hover)]` без границы
- Контейнер таб-бара получил `padding: "4px 8px"` для дыхания pill-кнопок

### STAB-09: Keyboard accessibility на disconnect

- `ServerTabs.tsx` disconnect button: добавлены `focus-visible:shadow-[var(--focus-ring)] outline-none` и `aria-label={t("control.disconnect")}`
- `StatusPanel.tsx` disconnect Button: добавлен `aria-label={t("buttons.disconnect")}`
- Оба disconnect действия теперь доступны через Tab+Enter/Space с видимым focus ring

### D-15: Tab maxWidth на широких окнах

`TabNavigation.tsx`: `width: 120` → `maxWidth: 120` на inline style кнопок. Вкладки теперь могут сжиматься ниже 120px на узких окнах, но не растягиваться на широких.

### D-17: Auth buttons контраст на светлой теме

`SshConnectForm.tsx` inactive auth segment: `bg-[var(--color-bg-secondary)]` → `bg-[var(--color-input-bg)]`. На светлой теме `--color-input-bg` = `#f4f4f1` даёт заметный контраст с белым фоном, а `--color-bg-secondary` = `#ffffff` был неотличим.

### D-16: Visual softness — --shadow-xs токен

`tokens.css`: добавлен `--shadow-xs` в оба блока тем:
- Dark: `0 1px 2px rgba(0, 0, 0, 0.20)`
- Light: `0 1px 2px rgba(0, 0, 0, 0.04)`

Используется активным тегом в ServerTabs для мягкой elevation.

### D-14 / D-19: Без изменений

- D-14 (layout shift): уже решён `display:flex|none` кэшированием вкладок в App.tsx
- D-19 (add server button): `ServerSidebar.tsx` не используется (placeholder multi-server)

## Verification Results

```
Test Files  93 passed, 1 failed (pre-existing), 3 skipped (97 total)
     Tests  1339 passed, 1 failed (pre-existing), 21 todo
  Duration  ~8s
```

Pre-existing сбой (`SshConnectForm.test.tsx > renders server IP and port labels`) существовал до наших изменений — использует ключ `labels.server_ip` вместо `labels.server_address`. Не введён нашими изменениями.

TypeScript: все ошибки typecheck — pre-existing (FoundStep, IconButton, PanelErrorBoundary и др.). Наши изменения типов не нарушают.

## Deviations from Plan

### Out-of-scope discoveries (deferred)

**1. Pre-existing test failure: `labels.server_ip` key**
- `SshConnectForm.test.tsx` line 191 использует `i18n.t("labels.server_ip")`, но компонент использует `labels.server_address`
- Существовало до наших изменений (подтверждено git stash проверкой)
- Логируется в deferred-items, не исправлено (out-of-scope Rule)

### Auto-fixed Issues

None — все изменения соответствовали плану.

## Items Requiring Visual Verification

Следующие изменения требуют визуальной проверки через `npm run tauri:dev`:

1. **D-18 Pill tabs в ServerTabs** — Активный таб должен выглядеть как "пилюля" с фоном bg-elevated и тенью, без подчёркивания. Остальные табы — прозрачные с hover-эффектом.

2. **D-17 Auth button контраст** — На светлой теме кнопки "Пароль | SSH-ключ": неактивная должна быть заметно темнее фона (input-bg vs secondary).

3. **D-15 Tab maxWidth** — На широких окнах (>720px) bottom tab bar должен оставаться в пределах 720px, кнопки не растягиваться шире 120px.

4. **STAB-09 Focus ring** — Нажатие Tab должно перемещать фокус на disconnect кнопку в ServerTabs, с видимым кольцом фокуса.

## Known Stubs

None.

## Threat Flags

None. Изменения затрагивают только визуальные стили и ARIA-атрибуты. Угрозы поверхности не расширяются.

## Self-Check: PASSED

- `gui-pro/src/components/ServerTabs.tsx` содержит `rounded-[var(--radius-md)]` ✓
- `gui-pro/src/components/ServerTabs.tsx` содержит `bg-[var(--color-bg-elevated)]` ✓
- `gui-pro/src/components/ServerTabs.tsx` НЕ содержит `border-b -mb-px` ✓
- `gui-pro/src/components/ServerTabs.tsx` содержит `focus-visible:shadow-[var(--focus-ring)]` ✓
- `gui-pro/src/components/ServerTabs.tsx` содержит `aria-label` ✓
- `gui-pro/src/components/StatusPanel.tsx` содержит `aria-label={t("buttons.disconnect")}` ✓
- `gui-pro/src/components/layout/TabNavigation.tsx` содержит `maxWidth: 120` ✓
- `gui-pro/src/components/server/SshConnectForm.tsx` содержит `bg-[var(--color-input-bg)]` ✓
- `gui-pro/src/shared/styles/tokens.css` содержит `--shadow-xs` ✓
- Коммит e0614653 существует ✓
