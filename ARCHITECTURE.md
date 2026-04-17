<!-- generated-by: gsd-doc-writer -->
# Архитектура TrustTunnel Client

Документ описывает внутреннее устройство системы: слои, процессы, паттерны IPC
и границы между двумя редакциями. Если вы хотите узнать **что** делает приложение
и **как его использовать** — смотрите [README.md](README.md). Правила
дизайн-системы и соглашения по коду живут в [CLAUDE.md](CLAUDE.md).

---

## 1. Общая схема

```text
┌────────────────────────────────────────────────────────────────────┐
│                       TrustTunnel.exe (Tauri 2)                    │
│                                                                    │
│  ┌──────────────────────────────┐   invoke    ┌──────────────────┐ │
│  │   Frontend (WebView2)        │ ──────────► │   Rust backend   │ │
│  │   React 19 + TypeScript      │             │   (lib.rs)       │ │
│  │   Tailwind + CSS-токены      │ ◄────────── │   ~73 команд     │ │
│  │   i18n (ru / en)             │    emit     │   tokio runtime  │ │
│  └──────────────────────────────┘             └────────┬─────────┘ │
│                                                        │           │
│                                                        │ spawn     │
│                                                        ▼           │
│                                          ┌─────────────────────────┤
│                                          │ Sidecar (C++, отдельный │
│                                          │ процесс)                │
│                                          │ trusttunnel_client.exe  │
│                                          │ WinTUN, DNS, SOCKS5     │
│                                          └─────────────────────────┘
└────────────────────────────────────────────────────────────────────┘
```

- **WebView2** рендерит React-дерево, общается с Rust исключительно через IPC.
- **Rust** владеет жизненным циклом sidecar-процесса, конфигом, трей-меню
  и SSH-подключением (только в Pro).
- **Sidecar** — отдельный C++ процесс, умирает независимо от GUI, работает
  с сетевым стеком Windows.

---

## 2. Две редакции в одном монорепо

| Каталог       | Пакет                 | Версия (на момент записи) | Роль                                  |
| ------------- | --------------------- | ------------------------- | ------------------------------------- |
| `gui-app/`    | `trusttunnel-gui`     | 3.0.0                     | Pro — SSH-деплой + подключение        |
| `gui-light/`  | `trusttunnel-light`   | 2.7.0                     | Light — только импорт и подключение   |

Обе редакции используют **один и тот же sidecar** (`trusttunnel_client.exe`)
и разделяют идеи дизайн-системы. Различие — в Rust-бэкенде и наборе экранов:

- `gui-app/src-tauri/src/` содержит модули `ssh/`, `tray.rs`,
  `commands/ssh_commands.rs`, `commands/activity_log.rs`, `commands/history.rs`,
  `commands/network.rs`, `commands/protocol.rs`, `commands/vpn.rs`.
- `gui-light/src-tauri/src/` содержит только `commands/config.rs`,
  `commands/deeplink.rs`, `commands/updater.rs`, `connectivity.rs`, `sidecar.rs` —
  то есть всё, что нужно для импорта конфига и запуска туннеля. SSH-модулей нет.

Версия и productName для Pro фиксируются в трёх файлах: `gui-app/package.json`,
`gui-app/src-tauri/Cargo.toml`, `gui-app/src-tauri/tauri.conf.json`. Light —
симметрично в `gui-light/…`.

---

## 3. Frontend: слои от корня к экранам

Точка входа — `gui-app/src/App.tsx`. Корневой компонент склеивает тему, язык,
контекст VPN, обработку deep-link, драг-дроп конфигов и верхнеуровневую
навигацию по табам (`AppTab` из `shared/types.ts`). VPN-состояние раздаётся
через `VpnProvider` (`shared/context/VpnContext.tsx`).

```text
App.tsx
├── TitleBar / TabNavigation / WindowControls   components/layout/
├── ControlPanelPage                            components/ControlPanelPage.tsx
│   ├── SshConnectForm                          components/server/SshConnectForm.tsx
│   └── ServerPanel                             components/ServerPanel.tsx
│       └── ServerTabs (5 табов)                components/ServerTabs.tsx
│           ├── OverviewSection                 components/server/OverviewSection.tsx
│           ├── UsersSection                    components/server/UsersSection.tsx
│           ├── ServerSettingsSection           components/server/ServerSettingsSection.tsx
│           ├── SecurityTabSection              components/server/SecurityTabSection.tsx
│           └── UtilitiesTabSection             components/server/UtilitiesTabSection.tsx
├── StatusPanel                                 components/StatusPanel.tsx
├── DashboardPanel / RoutingPanel / ...         components/*.tsx
└── AppSettingsPanel / AboutPanel               components/*.tsx
```

Пять серверных табов (`ServerTabs.tsx`, массив `tabs`): **Обзор**,
**Пользователи**, **Конфигурация**, **Безопасность**, **Утилиты**. Активация
вкладок — ручная (WAI-ARIA manual activation), чтобы навигация стрелками не
дёргала тяжёлые SSH-вкладки.

### Shared-слой

- **`shared/ui/`** — ~32 CVA-компонента (`Button`, `Input`, `Modal`, `Badge`,
  `Skeleton`, `StatusIndicator`, `StatCard`, `Accordion`, `OverflowMenu`,
  `Tooltip`, `ConfirmDialog`, `SnackBar`, …). Варианты описываются через
  `class-variance-authority`, классы сливаются через `cn()` из
  `shared/lib/cn.ts` (clsx + tailwind-merge с кастомной группой font-size).
- **`shared/hooks/`** — 20+ хуков: `useVpnEvents` (подписки на события
  бэкенда), `useVpnActions` (обёртки над `invoke`), `useTheme`, `useLanguage`,
  `useKeyboardShortcuts`, `useCollapse`, `useAutoConnect`, `useAutoSave`,
  `useActivityLog`, `useHostKeyVerification`, `useUpdateChecker`,
  `useTabPersistence`, `useConfigLifecycle`, `useFileDrop`.
- **`shared/styles/tokens.css`** — двухуровневые дизайн-токены: сначала
  «примитивы» (палитра, размеры), затем «семантические» (`--color-bg-primary`,
  `--color-text-inverse`, …).
- **`shared/i18n/locales/`** — `ru.json` и `en.json`; весь UI-текст проходит
  через `useTranslation()`.
- **`shared/context/VpnContext.tsx`** — единый источник правды для статуса
  VPN, конфига и логов.
- **`shared/types.ts`** — типы `AppTab`, `VpnStatus`, `VpnConfig`,
  `LogEntry`, `ThemeMode`.

Окно Tauri — 900×1000, `minWidth: 800`, `maxWidth: 1000`, `decorations: false`
(см. `tauri.conf.json`); свой TitleBar высотой 32 px висит на
`data-tauri-drag-region`.

---

## 4. Backend: модули и их роли

`gui-app/src-tauri/src/lib.rs` регистрирует плагины Tauri
(`single-instance`, `shell`, `dialog`, `window-state`, `notification`,
`autostart`), стейт приложения (`AppState`) и все команды. Далее структура:

| Путь                                  | Ответственность                                                          |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `commands/vpn.rs`                     | Коннект / дисконнект, спавн sidecar, стриминг `vpn-log`                  |
| `commands/ssh_commands.rs`            | Все операции с сервером: пользователи, конфиг, сертификаты, firewall     |
| `commands/config.rs`                  | Чтение/запись клиентского `trusttunnel_client.toml`, watcher файла       |
| `commands/network.rs`                 | Ping, DNS, детект адаптеров                                              |
| `commands/protocol.rs`                | Регистрация `tt://` / `trusttunnel://` deep-links                        |
| `commands/deeplink.rs`                | Обработка ссылок на импорт                                               |
| `commands/history.rs`                 | История подключений                                                      |
| `commands/activity_log.rs`            | Activity Log (связка USER→backend событий)                               |
| `commands/geoip.rs`                   | Поиск GeoIP                                                              |
| `commands/updater.rs`                 | Проверка релизов на GitHub                                               |
| `ssh/`                                | Клиент `russh`, пул соединений, хост-ключи                               |
| `sidecar.rs`                          | Spawning / watchdog / graceful shutdown `trusttunnel_client.exe`         |
| `routing_rules.rs`                    | Применение правил GeoIP/GeoSite                                          |
| `geodata.rs`, `geodata_v2ray.rs`      | Скачивание и парсинг geo-баз                                             |
| `connectivity.rs`                     | Мониторинг интернет-связности, авто-реконнект                            |
| `tray.rs`                             | Динамическое трей-меню с управлением VPN                                 |
| `processes.rs`                        | Поиск процессов (для фильтров маршрутизации)                             |
| `diagnostics.rs`, `logging.rs`        | Запись диагностики, файловое логирование                                 |

Общее количество атрибутов `#[tauri::command]` в `gui-app/src-tauri/src` —
около **73**; CLAUDE.md округляет до «~90», и это окно включает планируемые
в Phase 12–18.

Ключевые Rust-зависимости (`Cargo.toml`): `tauri 2`, `tokio 1`, `russh 0.46`
(SSH-клиент), `toml` / `toml_edit` (работа с конфигом), `reqwest` (HTTP),
`notify 7` (FS-watcher), `keyring 3.6` (хранение секретов в Windows Credential
Manager), `serde` / `serde_json`.

---

## 5. Паттерн IPC

Общение **строго однонаправлено по вызову**: фронт инициирует через `invoke`,
Rust отвечает значением Promise **и/или** шлёт события через `app.emit`.

```ts
// Вызов команды
import { invoke } from "@tauri-apps/api/core";
await invoke("connect_vpn", { configPath, logLevel });
```

```rust
// Эмит события в обратную сторону
app.emit("vpn-status", serde_json::json!({ "status": "connected" })).ok();
```

### Ключевые события

| Событие                 | Источник                          | Назначение                                         |
| ----------------------- | --------------------------------- | -------------------------------------------------- |
| `vpn-status`            | `sidecar.rs`, `tray.rs`           | `connecting` / `connected` / `disconnected` / `error` |
| `vpn-log`               | `commands/vpn.rs`                 | Построчный стрим логов sidecar                     |
| `internet-status`       | `connectivity.rs`                 | Онлайн/офлайн, триггер авто-реконнекта             |
| `geodata-progress`      | `geodata_v2ray.rs`                | Прогресс скачивания GeoIP/GeoSite                  |
| `geodata-files-changed` | `geodata_v2ray.rs`                | FS-watcher обнаружил изменения баз                 |
| `config-file-changed`   | `commands/config.rs`              | Внешнее изменение `trusttunnel_client.toml`        |
| `ssh-host-key-verify`   | `ssh/mod.rs`                      | Запрос пользовательского подтверждения fingerprint |
| `deep-link-url`         | `lib.rs` (single-instance)        | Открытие приложения с `tt://…`                     |
| `vpn-adapter-conflict`  | `commands/vpn.rs`                 | Конфликт WinTUN-адаптера                           |

На фронте подписки централизованы в `shared/hooks/useVpnEvents.ts`,
`useHostKeyVerification.ts`, `useConfigLifecycle.ts`,
`useActivityLogStartup.ts` — доменные хуки, а не россыпь `listen`
по компонентам.

---

## 6. Sidecar-процесс

Файл `gui-app/src-tauri/src/sidecar.rs` спавнит бинарник
`trusttunnel_client.exe` через Tauri shell (`externalBin` в
`tauri.conf.json`). Имя бинарника с целевой тройкой — например,
`trusttunnel_client-x86_64-pc-windows-msvc.exe`.

Рядом с бинарником должны лежать ресурсы из `tauri.conf.json → resources`:
`wintun.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`. В git эти файлы
не хранятся — сборщик копирует их из CMake-сборки (см. раздел
«Сборка из исходников» в [README.md](README.md#сборка-из-исходников)).

> **В git-worktree** sidecar и DLL-ы отсутствуют. Перед `cargo check`
> нужно `cp -r ../../../gui-app/sidecar ./sidecar` и прогнать `npm install`
> / `npm run build`, иначе tauri упадёт на этапе externalBin-проверки.

Изоляция процессов: после v2.3 выход одного приложения (Pro или Light)
не убивает VPN другого — каждый GUI владеет только **своим** child-процессом
sidecar, PID хранится в `AppState.sidecar_child`.

---

## 7. Сборка и артефакты

- `npm run dev` / `npm run tauri:dev` — Vite dev-сервер на `:1420` + Tauri
  в режиме горячей перезагрузки.
- `npm run prerelease` — полный заход: `typecheck → lint → test → clippy → build`.
- `npm run tauri build -- --bundles nsis` — итоговый NSIS-инсталлятор
  с кастомными хуками (`src-tauri/nsis/installer-hooks.nsh`) и локализацией
  RU/EN (см. `tauri.conf.json → bundle.windows.nsis`).
- Релизный профиль (`Cargo.toml → [profile.release]`) — `strip = true`,
  `lto = true`, `codegen-units = 1`, `opt-level = "s"`.

Итого на выходе: `TrustTunnel.exe` + ресурсы DLL + `trusttunnel_client.exe`,
упакованные в NSIS-инсталлятор (или портативный ZIP — см. раздел «Скачать»
в README).

---

## Смежные документы

- [README.md](README.md) — продуктовое описание, установка, быстрый старт.
- [CLAUDE.md](CLAUDE.md) — правила дизайн-системы, соглашения по коду,
  gotchas, localStorage-ключи.
- [.planning/phases/11-screen-ux-redesign/CONTROL-PANEL-SPEC.md](.planning/phases/11-screen-ux-redesign/CONTROL-PANEL-SPEC.md)
  — целевое состояние серверной панели (Phase 12–18).
