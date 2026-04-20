---
date: 2026-04-20
tags: [reference, architecture, overview]
topic: architecture
---

# Архитектура TrustTunnel Client

## Общее описание

TrustTunnel Client — Windows VPN-клиент с двумя GUI-изданиями, построенный как многослойная система:

- React 19 + TypeScript frontend
- Tauri v2 / Rust backend
- C++20 sidecar `trusttunnel_client.exe`
- сетевые и TCP/IP модули на стороне C++

## Слои

```text
React UI (gui-pro / gui-light)
  -> Tauri commands + events (Rust)
  -> trusttunnel_client.exe sidecar (C++)
  -> common / core / net / tcpip
```

### C++ слои

- `common/` — общие утилиты, FSM, platform abstractions, settings
- `core/` — туннель, upstream connectors, DNS orchestration, SOCKS listener, TUN orchestration
- `net/` — TLS, HTTP sessions, QUIC, sockets, OS tunnel, DNS management, pinger
- `tcpip/` — lwIP-интеграция, raw TCP/UDP/ICMP handling, packet pool

## GUI-издания

### Pro (`gui-pro`)

Source of truth:

- `gui-pro/src/`
- `gui-pro/src-tauri/`

Текущее окно из `gui-pro/src-tauri/tauri.conf.json`:

- `productName`: `TrustTunnel Client Pro`
- `identifier`: `com.trusttunnel.gui`
- `width`: `900`
- `height`: `1000`
- `minWidth`: `800`
- `minHeight`: `1000`
- `maxWidth`: `1000`
- `decorations: false` — используется кастомный title bar

Текущее shell-устройство на 2026-04-20:

- нижняя навигация на 5 табов: `control`, `connection`, `routing`, `settings`, `about`
- кастомный `TitleBar`
- SSH-driven Control Panel с вложенными server tabs
- общий design-system слой в `gui-pro/src/shared/`

### Light (`gui-light`)

Source of truth:

- `gui-light/src/`
- `gui-light/src-tauri/`

Текущее окно из `gui-light/src-tauri/tauri.conf.json`:

- `productName`: `TrustTunnel Client Light`
- `identifier`: `com.trusttunnel.light`
- `width`: `420`
- `height`: `680`
- `minWidth`: `380`
- `minHeight`: `600`
- `decorations: false`

Light остается облегченной веткой:

- нижняя навигация
- меньше экранов
- нет SSH control-panel surface уровня Pro

## Взаимодействие слоев

### Frontend -> Rust

Через `invoke()` и события Tauri.

Основные категории команд:

- VPN lifecycle
- config IO
- routing/geodata
- updater
- deep links
- logging
- SSH server management в Pro

Основные события:

- `vpn-status`
- `vpn-log`
- `config-file-changed`
- `internet-status`
- `deep-link-url`
- прогресс geodata/update операций

### Rust -> C++ sidecar

Прямого RPC между Rust и sidecar нет. Взаимодействие строится через:

- запись конфигурации на диск
- spawn sidecar-процесса
- чтение stdout/stderr
- вспомогательные файлы состояния рядом с приложением

### Portable data directory

Данные хранятся рядом с executable:

- `trusttunnel_client.toml`
- `routing_rules.json`
- `resolved/`
- `geodata/`
- `webview_data/`
- `connection_history.json`
- служебные файлы вроде `.sidecar.pid`, `.pending_deeplink`, `.start_minimized`

## Сетевой стек

- HTTP/2 upstream
- HTTP/3 / QUIC upstream
- TLS на BoringSSL
- WinTUN на Windows
- WFP для kill switch и системной сетевой интеграции
- lwIP в `tcpip/`
- anti-DPI механики

## Важное различие между документами и кодом

Некоторые ранние заметки описывают Pro как `gui-app` и более широкую IA на 8 экранов.

На текущую дату ориентироваться нужно на:

- `gui-pro/` как на реальный shipped desktop UI
- `.planning/` как на источник milestone- и follow-up статуса
- `memory/` как на объясняющий слой

## Связанные заметки

- [[frontend]] — текущее frontend-состояние
- [[rust-backend]] — Tauri/Rust слой
- [[networking]] — сетевой стек
- [[installer]] — установщик
- [[cpp-core]] — детали C++-ядра
