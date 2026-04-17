---
phase: 13
plan: 01
subsystem: rust-backend
tags: [tauri-command, http-client, geoip, ipwho-is, tdd, error-mapping]
requires:
  - reqwest (already in Cargo.toml)
  - serde / serde_json (already in Cargo.toml)
provides:
  - "Tauri command get_server_geoip(host) -> Result<GeoIpInfo, String>"
  - "Public struct GeoIpInfo { country, country_code, flag_emoji }"
  - "Error code namespace GEOIP_* (TIMEOUT / NO_NETWORK / RATE_LIMITED / INVALID_RESPONSE)"
affects:
  - "Frontend (Wave 2): useServerGeoIp.ts can now invoke('get_server_geoip')"
  - "Frontend (Wave 4): translateSshError gains GEOIP_* cases (Plan 13-04)"
  - "Frontend (Wave 3): OverviewSection wires Country card via useServerGeoIp (Plan 13-06)"
tech-stack:
  added: []
  patterns:
    - "reqwest::Client::builder().timeout(Duration::from_secs(5)).build() — Pattern из network.rs:7-10"
    - "Match-arm error branching on e.is_timeout() / e.is_connect() — адаптация connectivity.rs:241-253"
    - "#[derive(Deserialize)] partial-shape struct для парсинга только нужных полей JSON"
    - "Inline #[cfg(test)] mod tests — без интеграционных файлов tests/ (project convention)"
key-files:
  created:
    - "gui-app/src-tauri/src/commands/geoip.rs (128 строк): GeoIpInfo + IpWhoResponse + IpWhoFlag + get_server_geoip + 3 inline serde-теста"
    - ".planning/phases/13-ip-tls-ping-drill-down/deferred-items.md: документирование 81 pre-existing clippy-error в legacy-файлах (out-of-scope)"
  modified:
    - "gui-app/src-tauri/src/commands/mod.rs: добавлено `pub mod geoip;` после `pub mod network;`"
    - "gui-app/src-tauri/src/lib.rs: добавлено `commands::geoip::get_server_geoip,` в invoke_handler! (после speedtest_run, строка 340)"
    - "gui-app/src-tauri/Cargo.lock: автообновление при cargo test (без новых dependencies)"
decisions:
  - "RED-фаза TDD реализована через unimplemented!() body + 3 serde-теста на структуры (тесты не зависят от тела команды)"
  - "GREEN-фаза: точная копия Pattern 3 из 13-RESEARCH.md (план явно требует 'строго по коду')"
  - "Тесты используют Unicode escape `\\u{1f1fa}\\u{1f1f8}` вместо литерального эмодзи 🇺🇸 для encoding-агностичности исходника на Windows"
  - "Использовано `format!()` вместо raw-string для JSON в первом тесте: `\\u` в JSON-литерале — синтаксическая ошибка (требует ровно 4 hex-символа), что вызвало RED-test crash при первом прогоне (Rule 1 - Bug fixed)"
  - "Из 6 файлов плана модифицированы только моих 3 + Cargo.lock (cargo test side-effect); useServerGeoIp.ts и useServerStats.ts из untracked — это файлы будущих планов, не trogal"
  - "Pre-existing 81 clippy error на rust-clippy 1.94 — out-of-scope (SCOPE BOUNDARY правило), задокументированы в deferred-items.md"
metrics:
  duration: "~25 минут"
  completed: "2026-04-17"
---

# Phase 13 Plan 01: Rust Tauri-команда get_server_geoip — Summary

**One-liner:** Создан Tauri-command `get_server_geoip(host)` для GeoIP-lookup сервера через ipwho.is с типизированным `GeoIpInfo` и 4 кодами ошибок `GEOIP_*` (timeout / no_network / rate_limited / invalid_response), таймаут 5 сек, прозрачно для Tauri CSP (D-04, D-05, D-07, D-08).

## Что сделано

### Task 1: TDD-цикл get_server_geoip (RED + GREEN)
- **RED commit `5b7f4089`** — `test(13-01): add failing test scaffold for get_server_geoip`
  - Создан `gui-app/src-tauri/src/commands/geoip.rs` с тремя структурами:
    - `pub struct GeoIpInfo { country, country_code, flag_emoji }` (Serialize + Deserialize + Debug + Clone + PartialEq)
    - `struct IpWhoResponse { success, message, country, country_code, flag }` (partial deserialize)
    - `struct IpWhoFlag { emoji }` (вложенная структура для эмодзи флага)
  - Тело `get_server_geoip` — `unimplemented!()` placeholder
  - 3 inline `#[cfg(test)]` теста на serde-парсинг (без network I/O):
    - `deserializes_ipwho_success_response` — успешный JSON с emoji-флагом
    - `deserializes_ipwho_failure_response_with_message` — `success:false` + reserved range
    - `geoip_info_roundtrips_serde` — сериализация ↔ десериализация GeoIpInfo
  - Также добавлен `pub mod geoip;` в `commands/mod.rs` (требуется для запуска тестов)
  - **Cargo.lock** обновлён cargo test-сборкой (без новых deps)

- **GREEN commit `fb9f0ab3`** — `feat(13-01): implement get_server_geoip via ipwho.is with GEOIP_* error mapping`
  - `unimplemented!()` заменён на полную реализацию по Pattern 3 из 13-RESEARCH.md
  - HTTPS GET `https://ipwho.is/{host}` через `reqwest::Client::builder().timeout(Duration::from_secs(5)).build()`
  - Match-arm error mapping на `reqwest::Error::is_timeout()` / `is_connect()` + HTTP 429 + JSON parse fail + `success:false` из API
  - Возврат `Ok(GeoIpInfo { ... })` с `unwrap_or_default()` для всех Optional-полей IpWhoResponse

### Task 2: Регистрация команды в Tauri invoke_handler
- **Commit `1e449972`** — `feat(13-01): register get_server_geoip in tauri invoke_handler`
  - В `gui-app/src-tauri/src/lib.rs` после строки `commands::network::speedtest_run,` (строка 339) добавлена `commands::geoip::get_server_geoip,`
  - Команда теперь доступна фронту через `invoke<GeoIpInfo>("get_server_geoip", { host })`
  - Warning `function get_server_geoip is never used` исчез (был ожидаем после RED-фазы — функция была private с т.з. Tauri)
  - Также включён `deferred-items.md` с задокументированными pre-existing clippy-проблемами

## Коды ошибок (D-08)

| Код | Триггер | Источник |
|-----|---------|----------|
| `GEOIP_TIMEOUT` | reqwest >5s | `Err(e) if e.is_timeout()` |
| `GEOIP_NO_NETWORK` | connect error / fallback | `Err(e) if e.is_connect()` + general `Err(e)` ветка с detail |
| `GEOIP_RATE_LIMITED` | HTTP 429 | `resp.status().as_u16() == 429` |
| `GEOIP_INVALID_RESPONSE` | parse fail / `success:false` | `.json().await.map_err()` + `if !body.success` ветка |

Формат для ошибок с деталями: `GEOIP_INVALID_RESPONSE|{detail}`, `GEOIP_NO_NETWORK|{detail}` — pipe-separator паттерн совпадает с существующими `SSH_*` ошибками (translateSshError в Phase 12.5 ожидает `parts = raw.split("|")`).

## Verified

| Проверка | Команда | Результат |
|----------|---------|-----------|
| 3 inline serde-теста зелёные | `cargo test --lib commands::geoip` | `test result: ok. 3 passed; 0 failed` |
| Сборка без warnings к моим файлам | `cargo check` | `Finished `dev` profile ... in 1.40s` (после прогрева) |
| Сборка тестов без warnings к geoip | `cargo test --lib --no-run` | `warning generated` исчез после регистрации в lib.rs |
| Clippy на geoip.rs | `cargo clippy --all-targets 2>&1 \| grep geoip` | пустой вывод (0 замечаний) |
| Команда доступна в invoke_handler | `grep commands::geoip lib.rs` | `commands::geoip::get_server_geoip,` (строка 340) |

## Acceptance criteria (план)

- [x] `get_server_geoip(host)` Tauri-команда экспортирована и зарегистрирована
- [x] 4 кода ошибок GEOIP_* корректно маппятся
- [x] Таймаут ровно 5s (D-08), URL ровно `https://ipwho.is/{host}` (D-04)
- [x] 3 inline-теста serde зелёные (без network I/O)
- [x] Команда доступна фронту через `invoke<GeoIpInfo>("get_server_geoip", { host })`
- [x] cargo clippy на geoip — зелёный (0 замечаний). Прим. clippy для всего src-tauri имеет 81 pre-existing error в legacy-файлах — вне scope (см. deferred-items.md)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Исправлена синтаксическая ошибка JSON в первом тесте**
- **Found during:** Task 1 (RED-фаза, первый прогон тестов)
- **Issue:** Использование `\u{1f1fa}\u{1f1f8}` (Rust Unicode escape) **внутри JSON raw-string** — `\u` в JSON синтаксисе требует ровно 4 hex-символа (`\u1F1FA` без скобок), а не Rust-нотацию. serde упал с `Error("invalid escape", line: 5, column: 38)`.
- **Fix:** Перешёл на `format!()` с подстановкой переменной `us_flag = "\u{1f1fa}\u{1f1f8}"` в JSON-строку. Это даёт литеральную UTF-8 последовательность в JSON (которую serde парсит корректно), сохраняя при этом encoding-агностичность Rust исходника.
- **Files modified:** `gui-app/src-tauri/src/commands/geoip.rs` (тело теста `deserializes_ipwho_success_response`)
- **Commit:** `5b7f4089` (RED-фаза, fix перед коммитом)

### Деференшил-инфраструктура

**2. [Tooling - Out-of-scope] Установка clippy для stable-toolchain**
- В worktree-окружении `cargo clippy` падал с `cargo-clippy.exe is not installed for the toolchain stable-x86_64-pc-windows-msvc`. `gui-app/rust-toolchain.toml` фиксирует `channel = "stable"`, но clippy был установлен только для `1.88` (root toolchain).
- **Fix:** `rustup component add clippy --toolchain stable-x86_64-pc-windows-msvc` — clippy теперь доступен в обеих toolchains.
- Это **не** деформация плана (не меняет код), но логирую как инфраструктурный шаг для воспроизводимости.

## Threat Flags

Нет. Команда добавляет новую сетевую поверхность (HTTPS GET к ipwho.is), но это явно одобрено в `13-CONTEXT.md` D-07: «Размещать GeoIP-lookup через Rust-команду (не фронтовый fetch), чтобы… не делать HTTP-запрос с фронта (прозрачность для Tauri CSP)». Threat-модель плана уже учитывает это решение.

## Known Stubs

Нет. Все возвращаемые поля `GeoIpInfo` заполняются из реального API-ответа (или `unwrap_or_default()` при отсутствии поля — это валидное fallback-поведение, не stub).

## Deferred Issues

**1. Pre-existing clippy 1.94 errors в legacy-коде** (см. `deferred-items.md`)
- 81 ошибка clippy на `cargo clippy --all-targets -- -D warnings` во всём src-tauri.
- Файлы: `ssh/server/server_security.rs`, `tray.rs`, multiple `too_many_arguments` warnings и др.
- **Ноль** замечаний к `commands/geoip.rs` или к моим единичным правкам в `mod.rs`/`lib.rs`.
- Per SCOPE BOUNDARY rule (Rule scope) — out of scope для Plan 13-01. Должно быть отдельным clippy-cleanup планом.

## Self-Check: PASSED

**Files exist:**
- FOUND: `gui-app/src-tauri/src/commands/geoip.rs` (128 строк)
- FOUND: `gui-app/src-tauri/src/commands/mod.rs` (с `pub mod geoip;` на строке 5)
- FOUND: `gui-app/src-tauri/src/lib.rs` (с `commands::geoip::get_server_geoip,` на строке 340)
- FOUND: `.planning/phases/13-ip-tls-ping-drill-down/deferred-items.md`

**Commits exist:**
- FOUND: `5b7f4089` — `test(13-01): add failing test scaffold for get_server_geoip (TDD RED)`
- FOUND: `fb9f0ab3` — `feat(13-01): implement get_server_geoip via ipwho.is with GEOIP_* error mapping (TDD GREEN)`
- FOUND: `1e449972` — `feat(13-01): register get_server_geoip in tauri invoke_handler`

**TDD Gate Compliance:** RED commit (`test(13-01): ...`) precedes GREEN commit (`feat(13-01): ...implement...`) precedes registration commit (`feat(13-01): register...`). Sequence verified in `git log --oneline`.
