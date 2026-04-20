---
date: 2026-04-20
tags: [reference, rust, tauri, backend]
topic: rust-backend
---

# Rust / Tauri Backend

## Source of truth

Для desktop Pro:

- `gui-pro/src-tauri/src/`

Для Light:

- `gui-light/src-tauri/src/`

Старые упоминания `gui-app/src-tauri` в ранних заметках — исторические.

## Структура Pro backend (`gui-pro/src-tauri/src/`)

```text
src/
├── lib.rs
├── main.rs
├── connectivity.rs
├── diagnostics.rs
├── geodata.rs
├── geodata_v2ray.rs
├── logging.rs
├── processes.rs
├── routing_rules.rs
├── sidecar.rs
├── tray.rs
├── commands/
└── ssh/
```

### `commands/`

Текущие command-модули:

- `vpn.rs`
- `config.rs`
- `network.rs`
- `history.rs`
- `geoip.rs`
- `updater.rs`
- `deeplink.rs`
- `protocol.rs`
- `activity_log.rs`
- `ssh_commands.rs`

## Что делает backend

### Shell / app lifecycle

`lib.rs` управляет:

- single-instance behavior
- tray icon и tray menu
- custom window lifecycle
- startup initialization
- Tauri command registration
- event bridge между UI и backend

### VPN lifecycle

Через `commands::vpn` и `sidecar.rs` backend:

- запускает `trusttunnel_client`
- отслеживает sidecar state
- транслирует `vpn-status` и `vpn-log`
- делает disconnect / cleanup
- защищается от stale sidecar-процессов

### Config / routing / geodata

Через `config.rs`, `routing_rules.rs`, `geodata.rs`, `geodata_v2ray.rs` backend:

- читает и сохраняет client config
- следит за изменениями файла конфигурации
- импортирует drag-and-drop content
- хранит routing rules
- разрешает GeoIP / GeoSite / iplist группы
- скачивает и обновляет geodata

### Pro-only server management

Через `ssh_commands.rs` и `ssh/` backend у Pro есть большой SSH surface:

- deploy и diagnose сервера
- хранение SSH credentials
- installation checks
- export server config / deeplink
- user management
- service actions
- security tooling
- advanced user config и reconcile flows

### Logging / activity log

Отдельные слои:

- `logging.rs` — app logs, open logs folder, logging enabled flag
- `commands/activity_log.rs` — activity log initialization, write/export activity log

### Update / deeplink / protocol

- `updater.rs` — self-update flow
- `deeplink.rs` — decode/import config from deep link
- `protocol.rs` — URL protocol registration и polling pending deep links

## Текущие invoke-группы в Pro

Точный список команд надо смотреть в `gui-pro/src-tauri/src/lib.rs`, но по состоянию на 2026-04-20 там зарегистрированы группы:

- tray/menu utilities
- logging utilities
- VPN lifecycle
- SSH/server management
- config management
- routing and geodata
- process enumeration
- network tools
- history/session tracking
- updater
- deep links and URL protocol
- activity log

Это уже существенно шире, чем ранние заметки про "примерно 32 команды".

## Sidecar model

`sidecar.rs` остается ключевой точкой интеграции с C++:

- spawn `trusttunnel_client`
- передача `config_path` и `log_level`
- чтение stdout/stderr
- определение connected-state по логам sidecar
- emit событий для UI
- PID tracking и cleanup

## State и runtime behavior

Backend держит состояние приложения в `AppState` и связанных shared state-структурах:

- состояние sidecar child
- признаки intentional disconnect / connected state
- tray-related state
- locale / UI-related service state
- кеши geodata и SSH-пула

## Tray / window behavior

В Pro backend отвечает за:

- native tray icon
- rebuild tray menu при смене языка
- update tray icon при `vpn-status`
- start minimized flag
- кастомное поведение окна без стандартных decorations

## Light backend

`gui-light/src-tauri/src/` — облегченный backend без Pro SSH surface.

Он покрывает:

- VPN lifecycle
- config IO
- routing/geodata
- updater
- deep links
- logging
- process listing
- speedtest / ping

Light не содержит Pro-level server management и activity-log surface такого же масштаба.

## Практическое правило

Если задача касается backend:

1. сначала смотреть `gui-pro/src-tauri/src/lib.rs`
2. затем соответствующий модуль в `commands/` или root-level `.rs`
3. затем уже сверяться со старыми memory reference-заметками

## Связанные заметки

- [[architecture]] — общая архитектура
- [[frontend]] — frontend shell и UI
- [[networking]] — сетевой стек
- [[installer]] — installer/update context
