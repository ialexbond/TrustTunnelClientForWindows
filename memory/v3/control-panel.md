# Control Panel — Current `gui-pro` Snapshot

> Updated: 2026-04-20
> Source of truth: `gui-pro/src/components/ControlPanelPage.tsx`, `ServerPanel.tsx`, `ServerTabs.tsx`

---

## Что это за документ

Это не полный продуктовый spec, а рабочая reference-заметка по текущему Control Panel flow в shipped `gui-pro`.

Она нужна, чтобы быстро понять:

- как сейчас устроен entry flow в control tab
- какие server tabs реально существуют
- какие UX-решения уже реализованы
- что относится к shipped v3, а что уже к follow-up редизайну

## Текущий shell flow

Внешний shell живет в `gui-pro/src/App.tsx`:

- `control`
- `connection`
- `routing`
- `settings`
- `about`

`control` — это точка входа в SSH-driven server management flow.

## Entry flow в `ControlPanelPage`

Source:

- `gui-pro/src/components/ControlPanelPage.tsx`

Текущее поведение:

- чтение сохраненных SSH credentials через Tauri command
- миграция legacy localStorage credentials в backend storage
- восстановление последнего `host/user/port`
- при первом успешном connect показывается отдельный skeleton-state
- после загрузки рендерится `ServerPanel`
- при экспорте конфигурации shell может переключить пользователя в `connection`

### Persisted UX details

Control flow уже хранит и использует:

- `tt_ssh_last_host`
- `tt_ssh_last_user`
- `tt_ssh_last_port`

Disconnect:

- очищает backend SSH credentials
- не стирает last-used host/user/port
- сбрасывает current control session state

## `ServerPanel` и вложенные server tabs

Source:

- `gui-pro/src/components/ServerPanel.tsx`
- `gui-pro/src/components/ServerTabs.tsx`

Текущие server tabs:

- `overview`
- `users`
- `configuration`
- `security`
- `utilities`

Важно:

- это уже не старая схема с большим количеством равноправных вкладок
- destructive disconnect action вынесен отдельно от списка tabs
- активный server tab сохраняется в localStorage через `tt_active_tab`

## Текущие UX-решения в `ServerTabs`

Реализовано:

- manual-activation keyboard tabs
- persist active tab
- отдельная кнопка disconnect с confirm dialog
- activity log events на tab switching и disconnect flow
- cross-fade tabpanel switching

Это уже ближе к post-phase polish, чем к сырым phase-1/2 прототипам.

## Activity log integration

`ServerTabs.tsx` логирует через `useActivityLog`:

- `tab.switch target="{tabId}"`
- `server.disconnect.initiated`
- `server.disconnect.confirmed`
- `server.disconnect.cancelled`

Связанные backend/files:

- `gui-pro/src/shared/hooks/useActivityLog.ts`
- `gui-pro/src/shared/hooks/useActivityLogStartup.ts`
- `gui-pro/src-tauri/src/commands/activity_log.rs`
- `gui-pro/src-tauri/src/logging.rs`

## Error boundary and logs

`PanelErrorBoundary` в shared UI используется и в shell, и вокруг тяжелых панелей.

Текущее поведение:

- retry
- открыть папку логов через `open_logs_folder`
- optional navigation home action

Source:

- `gui-pro/src/shared/ui/PanelErrorBoundary.tsx`

## Что уже видно как follow-up слой

В `.planning/todos/pending/2026-04-15-*` лежит следующий UX-pass для control surface.

Там планируются:

- более выразительный bottom navigation
- новый server header
- dashboard-style overview
- более сильная users/security/tools information architecture

То есть:

- базовый control panel уже shipped и работает
- follow-up документы описывают не старт реализации, а следующую фазу polish/UX refinement

## Основные файлы

- `gui-pro/src/App.tsx`
- `gui-pro/src/components/ControlPanelPage.tsx`
- `gui-pro/src/components/ServerPanel.tsx`
- `gui-pro/src/components/ServerTabs.tsx`
- `gui-pro/src/components/server/`
- `gui-pro/src/shared/ui/PanelErrorBoundary.tsx`
- `gui-pro/src/shared/hooks/useActivityLog.ts`
- `gui-pro/src-tauri/src/commands/activity_log.rs`
