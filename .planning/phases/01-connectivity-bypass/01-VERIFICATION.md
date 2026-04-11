---
phase: 01-connectivity-bypass
verified: 2026-04-10T00:00:00Z
status: human_needed
score: 9/10 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Запустить gui-app с активным VPN, убедиться что connectivity-монитор не вызывает ложных переподключений"
    expected: "В течение 5+ минут с активным VPN никаких событий internet-status{online:false} при стабильном интернете"
    why_human: "Поведение CONN-05 (no false reconnects) зависит от runtime-сети и реального VPN-туннеля — нельзя проверить статическим grep"
---

# Phase 1: Connectivity Bypass — Verification Report

**Phase Goal:** VPN connectivity checks route through the physical adapter, not the VPN tunnel
**Verified:** 2026-04-10
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | gui-app определяет IP физического адаптера (Ethernet/WiFi), исключая WinTUN/VPN | VERIFIED | `find_physical_adapter_ip()` на строке 108, фильтры: OperStatus::Up, has_gateway, if_type Ethernet/WiFi, desc !contains wintun/vpn/virtual/tap- |
| 2 | gui-app TCP-проверки привязываются к физическому адаптеру через socket2 bind() | VERIFIED | `spawn_blocking` + `socket2::Socket::new` + `socket.bind(&SockAddr::from(...))` — строки 157–187 |
| 3 | gui-app HTTP-проверки используют reqwest с `local_address(physical_ip)` | VERIFIED | `.local_address(physical_ip)` на строках 199, 263 |
| 4 | При отсутствии физического адаптера gui-app fallback на дефолтную маршрутизацию без краша | VERIFIED | Паттерн `if let Some(ip) = tcp_ip { socket.bind(...) }` — bind пропускается если ip=None, reqwest local_address(None) корректен |
| 5 | gui-app использует порог 4 последовательных отказа перед объявлением offline | VERIFIED | `consecutive_failures >= 4 && was_online` строка 55 |
| 6 | gui-light определяет IP физического адаптера (идентичная логика gui-app) | VERIFIED | `find_physical_adapter_ip()` строка 109, идентичная фильтрация |
| 7 | gui-light TCP/HTTP-проверки привязаны к физическому адаптеру | VERIFIED | `socket2` + `spawn_blocking` + `local_address(physical_ip)` присутствуют (строки 159, 200) |
| 8 | gui-light сохраняет Light-профиль: 15s начальный sleep, 15s цикл, 3 отказа | VERIFIED | `from_secs(15)` строки 25, 30; `consecutive_failures >= 3` строка 54; `from_secs(30)` и `from_secs(20)` отсутствуют |
| 9 | Verbose file logging показывает IP адаптера, результаты TCP/HTTP на каждом цикле | VERIFIED | 14 вызовов `log_app` в каждом файле — gui-app: 14, gui-light: 14 |
| 10 | Connectivity-монитор не вызывает ложных переподключений VPN во время активного VPN | UNCERTAIN | Код реализует 4-/3-failure threshold + `was_online` guard — но поведение при реальном VPN runtime требует ручной проверки |

**Score:** 9/10 truths verified (truth #10 uncertain — needs human)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `gui-app/src-tauri/src/connectivity.rs` | socket2-bound connectivity с find_physical_adapter_ip() | VERIFIED | 283 строки, содержит все ключевые паттерны |
| `gui-app/src-tauri/Cargo.toml` | socket2 и ipconfig зависимости, версия 2.5.0 | VERIFIED | `socket2 = { version = "0.5", features = ["all"] }`, `ipconfig = "0.3"`, version = "2.5.0" |
| `gui-light/src-tauri/src/connectivity.rs` | socket2-bound connectivity, Light-профиль | VERIFIED | 283 строки, 15s/15s/3-failure, все ключевые паттерны |
| `gui-light/src-tauri/Cargo.toml` | socket2 и ipconfig зависимости, версия 2.5.0 | VERIFIED | Те же зависимости, version = "2.5.0" |
| `gui-app/src-tauri/tauri.conf.json` | version 2.5.0 | VERIFIED | `"version": "2.5.0"` |
| `gui-app/package.json` | version 2.5.0 | VERIFIED | `"version": "2.5.0"` |
| `gui-light/src-tauri/tauri.conf.json` | version 2.5.0 | VERIFIED | `"version": "2.5.0"` |
| `gui-light/package.json` | version 2.5.0 | VERIFIED | `"version": "2.5.0"` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `gui-app/src-tauri/src/connectivity.rs` | socket2 crate | `use socket2::{Socket, Domain, Type, Protocol, SockAddr}` | WIRED | Строка 1 |
| `gui-app/src-tauri/src/connectivity.rs` | ipconfig crate | `ipconfig::get_adapters()` | WIRED | Строка 109 |
| `gui-app/src-tauri/src/connectivity.rs` | reqwest local_address | `.local_address(physical_ip)` | WIRED | Строки 199, 263 |
| `gui-light/src-tauri/src/connectivity.rs` | socket2 crate | `use socket2::{Socket, Domain, Type, Protocol, SockAddr}` | WIRED | Строка 1 |
| `gui-light/src-tauri/src/connectivity.rs` | ipconfig crate | `ipconfig::get_adapters()` | WIRED | Строка 110 |
| `gui-light/src-tauri/src/connectivity.rs` | reqwest local_address | `.local_address(physical_ip)` | WIRED | Строки 200, 263 |

### Data-Flow Trace (Level 4)

Оба файла — не UI-компоненты, это Rust background-сервисы. Данные из `find_physical_adapter_ip()` напрямую используются в socket bind и reqwest builder — статический анализ достаточен.

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|-------------|--------|-------------------|--------|
| `gui-app/connectivity.rs` | `physical_ip` | `ipconfig::get_adapters()` OS API | Да — реальный Windows API | FLOWING |
| `gui-light/connectivity.rs` | `physical_ip` | `ipconfig::get_adapters()` OS API | Да — реальный Windows API | FLOWING |

### Behavioral Spot-Checks

Модули не запускаются без полного Tauri-приложения. `cargo check` подтверждён в SUMMARY — компиляция без ошибок в обоих проектах.

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| gui-app компилируется | `cargo check` (из SUMMARY 01-02) | 5 warnings, 0 errors | PASS |
| gui-light компилируется | `cargo check` (из SUMMARY 01-02) | 2 warnings, 0 errors | PASS |
| socket2 присутствует в gui-app | `grep "use socket2"` | 1 вхождение строка 1 | PASS |
| socket2 присутствует в gui-light | `grep "use socket2"` | 2 вхождения | PASS |

### Requirements Coverage

| Requirement | Описание | Source Plan | Status | Evidence |
|-------------|---------|------------|--------|---------|
| CONN-01 | Приложение определяет IP физического адаптера (Ethernet/WiFi), исключая VPN/WinTUN | 01-01, 01-02 | SATISFIED | `find_physical_adapter_ip()` в обоих файлах с полной фильтрацией wintun/vpn/virtual/tap |
| CONN-02 | TCP-проверки привязываются к физическому адаптеру через socket2 bind() | 01-01, 01-02 | SATISFIED | `socket.bind(&SockAddr::from(SocketAddr::new(ip, 0)))` в обоих файлах |
| CONN-03 | HTTP-проверки используют reqwest с local_address(physical_ip) | 01-01, 01-02 | SATISFIED | `.local_address(physical_ip)` в check_connectivity() и check_adapter_online() обоих файлов |
| CONN-04 | При отсутствии физического адаптера — fallback на дефолтную маршрутизацию | 01-01, 01-02 | SATISFIED | `if let Some(ip) = tcp_ip { socket.bind(...) }` — bind пропускается при None |
| CONN-05 | Монитор связи не вызывает ложных переподключений VPN | 01-01, 01-02 | NEEDS HUMAN | Код: 4/3-failure threshold + was_online guard — runtime-поведение нельзя проверить статически |

Все 5 требований CONN-01..05 зарегистрированы в обоих планах. Orphaned requirements: нет.

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|---------|--------|
| — | Нет TODO/FIXME/placeholder | — | — |
| — | Нет пустых реализаций (`return null`, `return {}`) | — | — |
| — | Нет захардкоженных пустых данных в rendering-контексте | — | — |

Сканирование anti-patterns: чисто.

### Human Verification Required

#### 1. CONN-05: No False VPN Reconnects

**Test:** Запустить gui-app Pro с активным VPN-соединением. Подождать 5–10 минут при стабильном интернет-соединении.

**Expected:** В логах не должно появляться `[connectivity] Declaring offline after 4 failures` и фронтенд не должен получать `internet-status { online: false }` пока интернет реально доступен.

**Why human:** Поведение зависит от runtime: реального VPN-туннеля, Windows сетевого стека, адаптерного маршрутирования. Статический анализ подтверждает правильную логику, но реальное отсутствие ложных срабатываний нельзя гарантировать без живого теста.

### Gaps Summary

Автоматических gaps нет. Единственный открытый вопрос — runtime-поведение CONN-05, требует ручной проверки.

---

_Verified: 2026-04-10_
_Verifier: Claude (gsd-verifier)_
