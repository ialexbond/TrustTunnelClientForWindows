---
created: 2026-04-15T08:20:58.756Z
title: "v3.1 детальная спецификация редизайна — 7-фазный план реализации"
area: ux
files:
  - gui-app/src/components/layout/TabNavigation.tsx
  - gui-app/src/components/ServerTabs.tsx
  - gui-app/src/components/ServerPanel.tsx
  - gui-app/src/components/ControlPanelPage.tsx
  - gui-app/src/components/server/ServerStatusSection.tsx
  - gui-app/src/components/server/UsersSection.tsx
  - gui-app/src/components/server/ConfigSection.tsx
  - gui-app/src/components/server/SecuritySection.tsx
  - gui-app/src/components/server/UtilitiesSection.tsx
  - gui-app/src/components/server/DangerZoneSection.tsx
  - gui-app/src/components/server/SshConnectForm.tsx
  - gui-app/src/shared/styles/tokens.css
  - gui-app/src/shared/ui/index.ts
---

## Problem

На основе полного UI/UX аудита (30+ проблем) составлена детальная спецификация редизайна v3.1 с конкретными дизайн-решениями, визуальными макетами в ASCII и файлами для изменения.

## Solution

### Стиль: Modern Dark Cinema (UI/UX Pro Max recommendation)
- Subtle gradient фон `#0a0a0f → #0d0d0d`
- Cards: `border-radius: 16px`, hairline border, top-edge highlight
- Easing: `cubic-bezier(0.16,1,0.3,1)` (Expo.out)
- Accent glow за primary buttons
- Палитра: Shield dark + connected green (VPN & Privacy Tool)

### Фаза A — Foundation (typography + новые компоненты)
- `--font-size-xs`: 10px → 11px
- Новые shared/ui: `Skeleton` (shimmer loading), `StatCard` (metric display), `StatusIndicator` (pulsating dot)
- Стандартизация Card variants

### Фаза B — Нижнее меню (TabNavigation)
- Высота 56→60px, иконки 18→20px, labels 10→11px
- Pill-индикатор активного таба (`bg-accent-tint-10`, `border-radius: 12px`)
- Замена иконок: `Cable→Plug`, `GitBranch→Route`
- Микро-анимация: scale(0.92→1.0) 200ms + opacity fade

### Фаза C — Server Header + Tab Bar
- Новый ServerHeader: StatusIndicator + hostname + version + overflow menu (⋮)
- Overflow menu: Disconnect, Reboot, Reinstall, Uninstall
- Реструктуризация 6→5 табов: "Статус" → "Обзор", "Danger Zone" → в overflow menu
- Badge-индикаторы на табах (security warnings, pending updates)

### Фаза D — Dashboard (бывший Status)
- Stat Grid: 4 StatCards (Status, Ping, Users, Uptime)
- Service Actions card: Restart (secondary) + Stop (danger-outline) — визуально отделены
- Quick Actions: Добавить пользователя, Поделиться конфигом

### Фаза E — Users
- Radio-list → expandable cards с avatar, inline actions, текстовые labels
- "Подключиться как" → inline primary button у каждого user
- Форма добавления: вертикальная раскладка, full-width поля
- Delete визуально отделён (красный, внизу expanded card)

### Фаза F — Config + Security + Tools
- Config: merge Version+Config, shared Toggle, syntax highlighting
- Security: Health Score card (ProgressBar + alert badges), collapsible аккордеон
- Tools: Logs → отдельная секция/modal, каждый tool как отдельная Card

### Фаза G — Документация (параллельно)
- Storybook stories для каждого нового/изменённого компонента
- memory/v3/ обновление: design-system, components-catalog, tokens, screens
- shell-architecture.md обновление

### Порядок реализации
A → B → C → D → E → F (G параллельно с каждой фазой)
