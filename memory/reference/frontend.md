---
date: 2026-04-20
tags: [reference, frontend, react, typescript, tailwind]
topic: frontend
---

# Frontend Reference

## Что считать source of truth

Для текущего desktop UI актуальны:

- `gui-pro/src/`
- `gui-light/src/`

Старые упоминания `gui-app/` в ранних memory-документах и changelog-заметках — это исторический слой, а не актуальная структура shipped UI.

## Технологический стек

- React 19
- TypeScript 5.9
- Tailwind CSS 3.4
- Vite 6
- Vitest
- i18next + react-i18next
- `@tauri-apps/api` v2
- `lucide-react`
- `recharts` в Pro
- Storybook в Pro

## Текущее устройство `gui-pro/src/`

```text
src/
├── App.tsx
├── main.tsx
├── index.css
├── tray-menu.tsx
├── components/
├── shared/
├── docs/
└── test/
```

### `components/`

Ключевые верхнеуровневые панели и shell-элементы:

- `ControlPanelPage.tsx`
- `SettingsPanel.tsx`
- `RoutingPanel.tsx`
- `AboutPanel.tsx`
- `AppSettingsPanel.tsx`
- `StatusPanel.tsx`
- `ServerPanel.tsx`
- `ServerTabs.tsx`
- `ServerSidebar.tsx`
- `SetupWizard.tsx`
- `layout/TitleBar.tsx`
- `layout/TabNavigation.tsx`
- `layout/WindowControls.tsx`

Подкаталоги:

- `server/` — SSH/server management sections
- `routing/` — routing UI
- `settings/` — config/settings blocks
- `dashboard/` — dashboard-related pieces
- `wizard/` — setup/deploy flow

### `shared/`

- `context/` — глобальные контексты, включая `VpnContext`
- `hooks/` — hooks для shell, VPN lifecycle, theme/language, file drop, logging
- `i18n/` — локализация
- `lib/` — helpers вроде `cn`
- `styles/` — design tokens и shared styles
- `ui/` — design-system primitives и patterns
- `utils/` — прикладные helpers
- `types.ts` — shared frontend types

## Текущее устройство shell в `gui-pro`

`gui-pro/src/App.tsx` на 2026-04-20 монтирует 5 основных табов:

- `control`
- `connection`
- `routing`
- `settings`
- `about`

Текущая оболочка:

- кастомный `TitleBar`
- нижняя `TabNavigation`
- единый container width до `1000px`
- `PanelErrorBoundary` вокруг тяжелых панелей
- `DropOverlay` для drag-and-drop
- `ConfirmDialogProvider` на уровне приложения

Важно:

- старые reference-заметки с боковым sidebar на 8 панелей описывают более раннюю или более широкую IA
- в репозитории все еще есть `DashboardPanel.tsx` и `LogPanel.tsx`, но они не входят в текущую табовую оболочку `App.tsx`

## Control / Connection / Routing flow

### Control

`ControlPanelPage.tsx` сейчас — это SSH-driven control surface:

- форма SSH credentials
- восстановление последнего `host/user/port`
- first-connect skeleton
- вход в `ServerPanel`
- экспорт server config обратно в client flow

### Connection

`SettingsPanel.tsx` работает как редактор клиентской VPN-конфигурации:

- путь к config берется из shell state
- при отсутствии конфига показывается `EmptyState`
- может инициировать reconnect

### Routing

`RoutingPanel.tsx` использует текущий `vpnMode`, connection state и geodata workflow.

## Key hooks в `gui-pro/src/shared/hooks`

Наиболее важные hooks сейчас:

- `useVpnActions`
- `useVpnEvents`
- `useTheme`
- `useLanguage`
- `useKeyboardShortcuts`
- `useFileDrop`
- `useConfigLifecycle`
- `useAutoConnect`
- `useTabPersistence`
- `useAppShellActions`
- `useActivityLog`
- `useActivityLogStartup`
- `useUpdateChecker`
- `useHostKeyVerification`
- `useAutoSave`

## Design System / Shared UI

Основной UI-kit находится в:

- `gui-pro/src/shared/ui/`
- `gui-pro/src/shared/styles/tokens.css`

Система уже заметно шире старых DOC-02 заметок. На текущую дату она включает не только базовые controls, но и более прикладные patterns:

- forms: `Input`, `NumberInput`, `PasswordInput`, `ActionInput`, `ActionPasswordInput`, `Select`, `Toggle`, `FormField`, `CIDRPicker`, `CharCounter`
- actions/feedback: `Button`, `IconButton`, `Badge`, `StatusBadge`, `StatusIndicator`, `ErrorBanner`, `SnackBar`, `Tooltip`, `ConfirmDialog`
- structure: `Card`, `CardHeader`, `Section`, `SectionHeader`, `Separator`, `Divider`, `Accordion`, `Modal`
- overlays/state: `DropOverlay`, `PanelErrorBoundary`, `ProgressBar`, `Skeleton`, `EmptyState`
- patterns: `OverflowMenu`, `StatCard`

## Tokens

Source of truth:

- `gui-pro/src/shared/styles/tokens.css`

Текущее состояние:

- двухуровневая token-система: primitives + semantic aliases
- dark/light themes
- slate-teal accent palette
- Geist Sans / Geist Mono как базовые семейства
- Outfit только для display-wordmark use cases
- semantic typography tokens
- motion, z-index, spacing, focus-ring tokens

Важно:

- старые заметки с indigo accent больше не отражают текущее состояние `gui-pro`

## Storybook

Storybook сейчас живет в:

- `gui-pro/.storybook/`

Есть stories как для foundation-слоя, так и для компонентов и shell-частей:

- `Colors.stories.tsx`
- `Spacing.stories.tsx`
- `Shadows.stories.tsx`
- `Typography.stories.tsx`
- stories для большинства shared UI primitives
- stories для `ControlPanelPage`, `ServerTabs`, `TabNavigation`, `TitleBar`, `WindowControls`

## Актуальные persistence-паттерны

По коду видно несколько устойчивых localStorage-ключей и persistence-точек:

- `tt_config_path`
- `tt_log_level`
- `tt_connected_since`
- `tt_ssh_last_host`
- `tt_ssh_last_user`
- `tt_ssh_last_port`
- `tt_active_tab` для server tabs

Theme/language persistence также идет через shared hooks.

## `gui-light` — текущие отличия

`gui-light/src/` — отдельный облегченный frontend с нижней навигацией и меньшей surface area.

Ключевые экраны:

- `VpnScreen.tsx`
- `RoutingScreen.tsx`
- `SettingsScreen.tsx`
- `AboutScreen.tsx`
- `BottomNav.tsx`
- `WindowControls.tsx`

Light не включает Pro-level SSH control-panel и связанную server management surface.

## Практическое правило для будущих задач

Если задача касается UI:

1. сначала смотреть `gui-pro/src/App.tsx`
2. затем `gui-pro/src/shared/ui/` и `tokens.css`
3. затем соответствующую panel/section story в Storybook
4. только потом сверяться со старыми memory-заметками

## Связанные заметки

- [[architecture]] — общая архитектура
- [[rust-backend]] — Tauri/Rust backend
- [[networking]] — сетевой стек
- [[v3-design-guidelines]] — визуальное направление v3
