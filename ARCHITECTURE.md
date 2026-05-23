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
│  │   Tailwind + CSS-токены      │ ◄────────── │   ~85 команд     │ │
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
| `gui-pro/`    | `trusttunnel-gui`     | 3.0.0                     | Pro — SSH-деплой + подключение        |
| `gui-light/`  | `trusttunnel-light`   | 2.7.0                     | Light — только импорт и подключение   |

Обе редакции используют **один и тот же sidecar** (`trusttunnel_client.exe`)
и разделяют идеи дизайн-системы. Различие — в Rust-бэкенде и наборе экранов:

- `gui-pro/src-tauri/src/` содержит модули `ssh/` (включая `server/` с 18
  подмодулями), `tray.rs`, `commands/ssh_commands.rs`, `commands/activity_log.rs`,
  `commands/history.rs`, `commands/network.rs`, `commands/protocol.rs`,
  `commands/vpn.rs`, `commands/updater.rs`.
- `gui-light/src-tauri/src/` содержит только `commands/config.rs`,
  `commands/deeplink.rs`, `commands/updater.rs`, `connectivity.rs`, `sidecar.rs` —
  то есть всё, что нужно для импорта конфига и запуска туннеля. SSH-модулей нет.

Версия и productName для Pro фиксируются в трёх файлах: `gui-pro/package.json`,
`gui-pro/src-tauri/Cargo.toml`, `gui-pro/src-tauri/tauri.conf.json`. Light —
симметрично в `gui-light/…`.

> **Корня `package.json` нет** — это монорепо без npm-workspaces; каждая
> редакция собирается из своего каталога (`cd gui-pro && npm install`).

---

## 3. Frontend: слои от корня к экранам

Точка входа — `gui-pro/src/App.tsx`. Корневой компонент склеивает тему, язык,
контекст VPN, обработку deep-link, драг-дроп конфигов и верхнеуровневую
навигацию по табам (`AppTab` из `shared/types.ts`). VPN-состояние раздаётся
через `VpnProvider` (`shared/context/VpnContext.tsx`).

```text
App.tsx
├── WelcomeTour (overlay, Phase 18)              components/welcome/
├── TitleBar / TabNavigation / WindowControls    components/layout/
├── ControlPanelPage                             components/ControlPanelPage.tsx
│   ├── SshConnectForm                           components/server/SshConnectForm.tsx
│   └── ServerPanel                              components/ServerPanel.tsx
│       └── ServerTabs (5 табов)                 components/ServerTabs.tsx
│           ├── OverviewSection                  components/server/OverviewSection.tsx
│           ├── UsersSection                     components/server/UsersSection.tsx
│           ├── ConfigurationTab                 components/server/ConfigurationTab.tsx
│           ├── SecurityTabSection               components/server/SecurityTabSection.tsx
│           └── ServiceTabSection                components/server/ServiceTabSection.tsx
├── StatusPanel                                  components/StatusPanel.tsx
├── DashboardPanel / RoutingPanel / ...          components/*.tsx
└── AppSettingsPanel / AboutPanel                components/*.tsx
```

Пять серверных табов (`ServerTabs.tsx`, массив `tabs`): **Обзор**,
**Пользователи**, **Конфигурация**, **Безопасность**, **Сервис**. Phase 19
переименовала последний таб «Утилиты» → «Сервис» (значение id `"service"`
в `ServerTabId` union, ~70 i18n-ключей `server.utilities.*` →
`server.service.*`); legacy значение `"utilities"` в `tt_active_tab` маппится
на `"service"` при чтении (см. `loadActiveTab()`). Активация вкладок — ручная
(WAI-ARIA manual activation), чтобы навигация стрелками не дёргала тяжёлые
SSH-вкладки.

**Структура таба «Сервис»** (6 блоков, canonical order — Phase 19):
1. BBR Toggle Card
2. MTProto Card + Modal
3. Benchmark Card + Modal
4. **ProtocolUpdate Card** (Phase 19, между Benchmark и Logs)
5. Logs Card + Modal
6. Danger Zone Accordion

**Каскадные индикаторы обновлений** (Phase 18/19) — UI отражает наличие
доступной версии через четыре «точки входа»:

- 8×8 accent-точка справа сверху на pill-кнопке нижнего бара «Панель
  управления» (`hasSidecarUpdate`) и «О программе» (`hasAppUpdate`) —
  см. `TabNavigation.tsx`.
- Точка на под-вкладке «Сервис» в `ServerTabs.tsx` (скрывается, когда
  вкладка активна).
- Иконка `ArrowUp` цвета `--color-warning-500` рядом с «Версия протокола» —
  карточка #8 в `OverviewSection`. Drill-down ведёт сразу в таб «Сервис».
- Бейдж «Доступно новое обновление» внутри `ProtocolUpdateSection`.

### Shared-слой

- **`shared/ui/`** — ~36 CVA-компонентов (`Button`, `Input`, `Modal`, `Badge`,
  `Skeleton`, `StatusIndicator`, `StatCard`, `Accordion`, `OverflowMenu`,
  `Tooltip`, `ConfirmDialog`, `SnackBar`, …). Варианты описываются через
  `class-variance-authority`, классы сливаются через `cn()` из
  `shared/lib/cn.ts` (clsx + tailwind-merge с кастомной группой font-size).
- **`shared/hooks/`** — 21 хук: `useVpnEvents` (подписки на события
  бэкенда), `useVpnActions` (обёртки над `invoke`), `useTheme`, `useLanguage`,
  `useKeyboardShortcuts`, `useCollapse`, `useAutoConnect`, `useAutoSave`,
  `useActivityLog`, `useHostKeyVerification`, `useUpdateChecker` (dual
  app+sidecar polling, 24h cadence — Phase 18), `useTabPersistence`,
  `useConfigLifecycle`, `useFileDrop`, `useWelcomeTour` (Phase 18).
- **`shared/styles/tokens.css`** — двухуровневые дизайн-токены: сначала
  «примитивы» (палитра, размеры), затем «семантические» (`--color-bg-primary`,
  `--color-text-inverse`, …).
- **`shared/i18n/locales/`** — `ru.json` и `en.json`; весь UI-текст проходит
  через `useTranslation()`.
- **`shared/context/VpnContext.tsx`** — единый источник правды для статуса
  VPN, конфига и логов.
- **`shared/types.ts`** — типы `AppTab`, `ServerTabId`, `VpnStatus`,
  `VpnConfig`, `LogEntry`, `ThemeMode`, `UpdateInfo` (dual-detection поля
  `appAvailable` + `sidecarAvailable` + `sidecarDismissed`).

Окно Tauri — 900×1000, `minWidth: 800`, `maxWidth: 1000`, `decorations: false`
(см. `tauri.conf.json`); свой TitleBar высотой 32 px висит на
`data-tauri-drag-region`.

---

## 4. Backend: модули и их роли

`gui-pro/src-tauri/src/lib.rs` регистрирует плагины Tauri
(`single-instance`, `shell`, `dialog`, `window-state`, `notification`,
`autostart`), стейт приложения (`AppState`) и все команды. Далее структура:

| Путь                                  | Ответственность                                                          |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `commands/vpn.rs`                     | Коннект / дисконнект, спавн sidecar, стриминг `vpn-log`                  |
| `commands/ssh_commands.rs`            | ~75 SSH-команд для серверной панели (пользователи, конфиг, firewall)     |
| `commands/config.rs`                  | Чтение/запись клиентского `trusttunnel_client.toml`, watcher файла       |
| `commands/network.rs`                 | Ping, DNS, детект адаптеров                                              |
| `commands/protocol.rs`                | Регистрация `tt://` / `trusttunnel://` deep-links                        |
| `commands/deeplink.rs`                | Обработка ссылок на импорт                                               |
| `commands/history.rs`                 | История подключений                                                      |
| `commands/activity_log.rs`            | Activity Log (связка USER→backend событий)                               |
| `commands/geoip.rs`                   | Поиск GeoIP                                                              |
| `commands/updater.rs`                 | Проверка релизов на GitHub; `list_sidecar_versions` (Phase 19) — последние 4 sidecar-релиза для дропдауна |
| `ssh/`                                | Клиент `russh`, пул соединений, хост-ключи, channel gate                 |
| `ssh/server/`                         | 18 подмодулей серверного управления (см. ниже)                           |
| `sidecar.rs`                          | Spawning / watchdog / graceful shutdown `trusttunnel_client.exe`         |
| `routing_rules.rs`                    | Применение правил GeoIP/GeoSite                                          |
| `geodata.rs`, `geodata_v2ray.rs`      | Скачивание и парсинг geo-баз                                             |
| `connectivity.rs`                     | Мониторинг интернет-связности, авто-реконнект                            |
| `tray.rs`                             | Динамическое трей-меню с управлением VPN                                 |
| `processes.rs`                        | Поиск процессов (для фильтров маршрутизации)                             |
| `diagnostics.rs`, `logging.rs`        | Запись диагностики, файловое логирование                                 |

**`ssh/server/` — подмодули серверного управления:**

| Подмодуль                  | Ответственность                                                       |
| -------------------------- | --------------------------------------------------------------------- |
| `server_install.rs`        | Установка endpoint + systemd unit                                     |
| `server_security.rs`       | UFW + Fail2Ban                                                        |
| `server_config.rs`         | `vpn.toml`, `credentials.toml`, `rules.toml`                          |
| `server_hosts.rs`          | `hosts.toml` allowed_sni                                              |
| `server_mtproto.rs`        | **Phase 17.1: telemt rewrite** — 7-шаговая установка (cleanup_legacy → download_binary → create_user → configure_telemt → start_service → open_firewall → complete), хирургический uninstall (D-3.7) |
| `server_rules.rs`          | Anti-DPI per-user prefix                                              |
| `server_monitoring.rs`     | Статистика / uptime                                                   |
| `server_bbr.rs`            | BBR congestion control                                                |
| `server_lifecycle.rs`      | restart/stop/start service, reboot                                    |
| `server_uptime.rs`         | Парсинг uptime                                                        |
| `server_version.rs`        | Версии sidecar на сервере                                             |
| `server_ssh_key.rs`        | Phase 16 — Ed25519 keypair + keyring                                  |
| `server_update.rs`         | **Phase 18: atomic-swap sidecar update** — 7 backend-шагов (download_tarball → extract → backup → swap → restart → verify → complete), маппинг в 4 UI-шага, авто-rollback из `.bak` при `UPDATE_VERIFY_TIMEOUT` / `UPDATE_CANCELLED`, хирургический инвариант (D-3.7) |
| `server_benchmark.rs`      | Phase 17 — streaming SSH + cancel watchdog                            |
| `users_advanced.rs`        | Phase 14.1 — TLV-based users                                          |
| `cert_probe.rs`            | TLS endpoint probe через `tokio-rustls`                               |
| `tlv_encoder.rs`           | TLV wire format для deep-links                                        |

Общее количество атрибутов `#[tauri::command]` в `gui-pro/src-tauri/src` —
**~85**: 4 VPN + ~75 SSH-команд + остальные (routing / geodata / updater /
history / deeplink / protocol / activity_log / tray / logging / processes /
ssh-host-key-confirm). Полный реестр — в `invoke_handler!` блоке
`gui-pro/src-tauri/src/lib.rs` (строки 299–472).

**Ключевые phase-rewrites бэкенда:**

- **Phase 17.1 (telemt)** — `server_mtproto.rs` переписан с MTProxy
  (C-bинарь, падал на Ubuntu 24.04 с PID > 65535 assertion) на **telemt**
  (Rust+Tokio с pre-built бинарями в GitHub Releases). Установка
  идемпотентна (cleanup_legacy шаг убирает старый MTProxy unit + ufw rule
  by-number), управление через admin API на `127.0.0.1:9091` с whitelist
  (D-1.9). Cancel через `AppState.mtproto_install_cancel: AtomicBool`,
  проверяется между `exec_command`-шагами. Полный контекст —
  `memory/project_phase17.1_telemt_rewrite.md`.
- **Phase 18 (atomic-swap update)** — `server_update.rs` (779 LOC) реализует
  безопасное обновление `/opt/trusttunnel/trusttunnel_endpoint` через `.bak`-копию.
  7 backend-шагов эмитятся событием `update-protocol-step`; фронт мапит их
  в 4 UI-шага («Скачивание» / «Резервная копия» / «Применение» / «Проверка»)
  через константу `BACKEND_TO_UI_STEP` в `UpdateProgressModal`. Verify-цикл —
  6×2s `systemctl is-active` с cancel-чекпоинтом внутри loop (≤2s реакция
  на Cancel). Хирургический инвариант (D-3.7, static-grep тест):
  pipeline трогает **только** `ENDPOINT_BINARY` + `.bak` + `/tmp/tt_update*`,
  никогда не касается `vpn.toml`, `credentials.toml`, Let's Encrypt,
  certbot, ufw, telemt. Cancel через `AppState.update_sidecar_cancel:
  AtomicBool`.
- **Phase 19 (Service tab + cascade)** — `commands/updater.rs` получил
  команду `list_sidecar_versions(params)`: запрашивает GitHub Releases API,
  возвращает последние 4 версии (с дедупликацией текущей) для дропдауна
  в `ProtocolUpdateSection`. Существующая Phase 18 команда `update_sidecar`
  принимает опциональный `target_version` без изменений; новый
  `useSidecarVersions` хук отделён от `useUpdateChecker` (Pitfall 6 —
  чтобы не сломать `AboutPanel` regression suite).

Ключевые Rust-зависимости (`Cargo.toml`): `tauri 2`, `tokio 1`, `russh 0.46`
(SSH-клиент), `toml` / `toml_edit` (работа с конфигом), `reqwest` (HTTP),
`notify 7` (FS-watcher), `keyring 3.6` (хранение секретов в Windows Credential
Manager), `ssh-key 0.6` (Phase 16, генерация Ed25519), `tokio-rustls` +
`rustls-platform-verifier` (Phase 14.1, cert probe), `serde` / `serde_json`,
`uuid` (UUID heredoc delimiters — S-04 invariant).

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

| Событие                      | Источник                                | Назначение                                                  |
| ---------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| `vpn-status`                 | `sidecar.rs`, `tray.rs`                 | `connecting` / `connected` / `disconnected` / `error`       |
| `vpn-log`                    | `commands/vpn.rs`                       | Построчный стрим логов sidecar                              |
| `internet-status`            | `connectivity.rs`                       | Онлайн/офлайн, триггер авто-реконнекта                      |
| `geodata-progress`           | `geodata_v2ray.rs`                      | Прогресс скачивания GeoIP/GeoSite                           |
| `geodata-files-changed`      | `geodata_v2ray.rs`                      | FS-watcher обнаружил изменения баз                          |
| `config-file-changed`        | `commands/config.rs`                    | Внешнее изменение `trusttunnel_client.toml`                 |
| `ssh-host-key-verify`        | `ssh/mod.rs`                            | Запрос пользовательского подтверждения fingerprint          |
| `deep-link-url`              | `lib.rs` (single-instance)              | Открытие приложения с `tt://…`                              |
| `vpn-adapter-conflict`       | `commands/vpn.rs`                       | Конфликт WinTUN-адаптера                                    |
| `deploy-step` / `deploy-log` | `ssh/deploy.rs`                         | Прогресс установки сервера в Setup Wizard                   |
| `mtproto-install-step`       | `ssh/server/server_mtproto.rs`          | 7-шаговая установка telemt (Phase 17.1)                     |
| `benchmark-progress`         | `ssh/server/server_benchmark.rs`        | Процент выполнения benchmark (Phase 17)                     |
| `benchmark-stdout-chunk`     | `ssh/server/server_benchmark.rs`        | Сырые байты stdout от benchmark (для парсинга на фронте)    |
| `update-protocol-step`       | `ssh/server/server_update.rs`           | Атомарное обновление sidecar — 7 backend-шагов (Phase 18)   |
| `update-progress`            | `commands/updater.rs`                   | Self-update приложения                                      |
| `update-tray-language`       | `useLanguage` (frontend → Rust)         | Перестроить трей-меню в текущей локали                      |

На фронте подписки централизованы в `shared/hooks/useVpnEvents.ts`,
`useHostKeyVerification.ts`, `useConfigLifecycle.ts`,
`useActivityLogStartup.ts`, `useUpdateProgress.ts` (для
`update-protocol-step`) — доменные хуки, а не россыпь `listen`
по компонентам.

---

## 6. Sidecar-процесс

Файл `gui-pro/src-tauri/src/sidecar.rs` спавнит бинарник
`trusttunnel_client.exe` через Tauri shell (`externalBin` в
`tauri.conf.json`). Имя бинарника с целевой тройкой — например,
`trusttunnel_client-x86_64-pc-windows-msvc.exe`.

Рядом с бинарником должны лежать ресурсы из `tauri.conf.json → resources`:
`wintun.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`. В git эти файлы
не хранятся — сборщик копирует их из CMake-сборки (см. раздел
«Сборка из исходников» в [README.md](README.md#сборка-из-исходников)).

> **В git-worktree** sidecar и DLL-ы отсутствуют. Перед `cargo check`
> нужно `cp -r ../../../gui-pro/sidecar ./sidecar` и прогнать `npm install`
> / `npm run build`, иначе tauri упадёт на этапе externalBin-проверки.

Изоляция процессов: после v2.3 выход одного приложения (Pro или Light)
не убивает VPN другого — каждый GUI владеет только **своим** child-процессом
sidecar, PID хранится в `AppState.sidecar_child`.

> **Серверный endpoint-бинарник** (`/opt/trusttunnel/trusttunnel_endpoint`)
> и его systemd-unit `trusttunnel` — отдельная сущность; именно его
> обновляет atomic-swap pipeline из `server_update.rs`. Не путать
> с клиентским sidecar.

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
- [.planning/codebase/ARCHITECTURE.md](.planning/codebase/ARCHITECTURE.md) —
  глубокая карта кода с LOC, потоками данных и анти-паттернами
  (обновлена 2026-05-23).
- [.planning/phases/11-screen-ux-redesign/CONTROL-PANEL-SPEC.md](.planning/phases/11-screen-ux-redesign/CONTROL-PANEL-SPEC.md)
  — целевое состояние серверной панели (Phase 12–19).
