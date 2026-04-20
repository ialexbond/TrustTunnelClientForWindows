---
created: 2026-04-15T08:15:09.997Z
title: "Полный UX-редизайн панели управления и нижнего меню"
area: ux
files:
  - gui-pro/src/components/layout/TabNavigation.tsx
  - gui-pro/src/components/ServerTabs.tsx
  - gui-pro/src/components/ServerPanel.tsx
  - gui-pro/src/components/ControlPanelPage.tsx
  - gui-pro/src/components/server/ServerStatusSection.tsx
  - gui-pro/src/components/server/UsersSection.tsx
  - gui-pro/src/components/server/ConfigSection.tsx
  - gui-pro/src/components/server/SecuritySection.tsx
  - gui-pro/src/components/server/UtilitiesSection.tsx
  - gui-pro/src/components/server/DangerZoneSection.tsx
  - gui-pro/src/components/server/SshConnectForm.tsx
  - gui-pro/src/shared/styles/tokens.css
---

## Problem

Полный UI/UX аудит выявил 30+ проблем в панели управления и нижнем меню по стандартам Apple HIG, Material Design и WCAG. Ключевые категории:

### Нижнее меню (TabNavigation)
- N-1: Шрифт labels 10px — ниже минимума читаемости (стандарт: 12px+)
- N-2: Нет визуального индикатора активного таба (pill/dot)
- N-3: Иконки 18px маловаты, нужно 20-22px
- N-4: Неудачные иконки: Cable (подключение), GitBranch (маршрутизация) — не считываются
- N-6: Нет анимации перехода между табами

### Server Tabs (внутренний таб-бар)
- T-1: 6 табов на 900px — сжато, мелкий текст
- T-2: "Опасная зона" в одном ряду с обычными табами — деструктивная навигация не отделена
- T-3: Server header: критическая информация в 10px, disconnect без подтверждения
- T-5: Нет badge-индикаторов на табах

### Status tab
- S-1: Скудная информация — только status + ping, нет uptime/version/users count
- S-2: Безопасные и опасные кнопки в одном ряду (Перезапустить рядом с Перезагрузить сервер)
- S-5: Нет visual dashboard — чисто текстовый

### Users tab
- U-1: 4 icon-only кнопки на строку без labels
- U-2: Radio-selection для "Подключиться как" — неочевидный UX
- U-3: Форма добавления username+password в одну строку — слишком тесно

### Config tab
- C-1: Текст 10-11px для значений конфигурации
- C-2: Кастомные switch вместо shared Toggle компонента

### Security tab
- SEC-1: 3 секции в одной вкладке — перегружено
- SEC-2: Нет приоритизации — всё показано одинаково

### Tools tab
- TL-1: Logs в Tools — семантически неверно

### Danger Zone
- D-1: Целый таб для 2 кнопок — пустое пространство

## Solution

7-фазный план редизайна:

**Фаза A — Фундамент (дизайн-система)**
- Обновить typography scale: xs=11px, sm=12px, base=14px
- Стандартизировать Card variants, добавить Skeleton component
- Обновить tokens.css

**Фаза B — Нижнее меню**
- 60px высота, 20px иконки, 11px labels
- Pill-индикатор активного таба
- Замена иконок (Cable→Plug, GitBranch→Route)
- Микро-анимация переключения

**Фаза C — Server Header + Tab Bar**
- Новый Server Header: статус-точка + hostname + version + disconnect
- Реструктуризация 6→5 табов (Danger Zone → overflow/footer)
- Badge-индикаторы

**Фаза D — Status (Dashboard)**
- Hero status card с пульсацией
- Stat-карточки: version, users, ping, uptime
- Разделение действий по опасности

**Фаза E — Users**
- Expandable user cards
- Inline Connect As
- Вертикальная форма добавления

**Фаза F — Config + Security + Tools**
- Merge Version + Config
- Security Health Score + collapsible sections
- Logs в отдельную секцию

**Фаза G — Документация**
- Storybook stories
- memory/v3/ документация
- components-catalog.md, tokens.md
