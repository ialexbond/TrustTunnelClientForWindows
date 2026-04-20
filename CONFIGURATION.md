<!-- generated-by: gsd-doc-writer -->
# CONFIGURATION

Справочник по настраиваемым параметрам TrustTunnel Client: что можно крутить во время сборки и во время работы. Документ описывает **какие ручки существуют** — не то, как устроена архитектура (см. `ARCHITECTURE.md`) и не то, как добавлять новые команды (см. `DEVELOPMENT.md`).

Все пути указаны относительно редакции **Pro** (`gui-pro/`); в Light (`gui-light/`) структура идентична.

---

## 1. Build-time конфигурация

### `gui-pro/src-tauri/tauri.conf.json`

| Ключ | Значение | Описание |
|------|----------|----------|
| `productName` | `TrustTunnel Client Pro` | Имя продукта (отображается в инсталляторе и меню "Пуск") |
| `version` | `3.0.0` | Версия приложения (должна совпадать с `Cargo.toml` и `package.json`) |
| `identifier` | `com.trusttunnel.gui` | Bundle identifier |
| `app.windows[0].width` / `height` | `900` × `1000` | Стартовый размер окна |
| `app.windows[0].minWidth` / `maxWidth` | `800` / `1000` | Диапазон ширины (resizable, но не maximizable) |
| `app.windows[0].decorations` | `false` | Кастомный TitleBar (32 px) вместо стандартной рамки |
| `app.windows[0].backgroundColor` | `#0d0d0d` | Цвет фона до загрузки React |
| `app.windows[0].dragDropEnabled` | `false` | Drag-drop обрабатывается через HTML5 FileReader |
| `app.security.csp` | `null` | CSP выключен (окно — Tauri-shell, а не веб) |
| `bundle.externalBin` | `["trusttunnel_client"]` | Сайдкар-бинарник `trusttunnel_client-x86_64-pc-windows-msvc.exe` |
| `bundle.resources` | `wintun.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` | DLL, копируемые рядом с exe |
| `bundle.windows.nsis.languages` | `["Russian", "English"]` | Языки инсталлятора (кастомные `.nsh` в `nsis/`) |
| `bundle.windows.nsis.installerHooks` | `nsis/installer-hooks.nsh` | NSIS-хуки (автозапуск, firewall, TAP-драйвер) |
| `bundle.windows.allowDowngrades` | `true` | Разрешает установку поверх более новой версии |
| `plugins.shell.open` | `true` | Разрешает `shell.open()` для внешних ссылок |

Dev-вариант — `tauri.dev.conf.json` (используется через `npm run tauri:dev`).

### `gui-pro/package.json` — scripts

| Script | Назначение |
|--------|-----------|
| `dev` | Vite dev-сервер (только фронтенд, порт `1420`) |
| `tauri:dev` | Tauri-приложение с hot reload |
| `build` | Vite production-сборка в `dist/` |
| `typecheck` | `tsc --noEmit` (strict-режим) |
| `lint` | ESLint, `--max-warnings 0` |
| `test` | Vitest run |
| `rust:check` | `cargo clippy -- -D warnings` |
| `prerelease` | Полный pipeline: typecheck + lint + test + clippy + build |
| `storybook` | Storybook dev-сервер на `:6006` |

### `gui-pro/src-tauri/Cargo.toml`

**Плагины Tauri 2:** `tauri-plugin-shell`, `tauri-plugin-dialog`, `tauri-plugin-window-state`, `tauri-plugin-single-instance`, `tauri-plugin-notification`, `tauri-plugin-autostart`.

**Ключевые зависимости:** `russh 0.46` (SSH-клиент), `reqwest 0.13` (HTTP), `notify 7` (file watcher), `keyring 3.6` (Windows credential manager), `toml`/`toml_edit`, `tokio` (full).

**`[profile.release]`:** `strip = true`, `lto = true`, `codegen-units = 1`, `opt-level = "s"` — оптимизация по размеру, а не по скорости.

**Features:** `custom-protocol` (по умолчанию), `devtools` (DevTools в сборке), `test`.

---

## 2. Runtime-конфигурация клиента

### localStorage (браузерное хранилище Tauri WebView)

| Ключ | Назначение | Записывается | Очищается |
|------|-----------|--------------|-----------|
| `tt_ssh_last_host` | Последний SSH-хост | При подключении по SSH | Никогда (persist) |
| `tt_ssh_last_user` | Последний SSH-пользователь | При подключении | Никогда |
| `tt_ssh_last_port` | Последний SSH-порт (default `22`) | При подключении | Никогда |
| `tt_config_path` | Путь к TOML-конфигу VPN | После импорта/выбора конфига | При явном "Забыть конфиг" (`tt_config_cleared=true`) |
| `tt_log_level` | Уровень логов sidecar (`info`/`debug`/…) | Из настроек | Никогда |
| `tt_active_tab` / `tt_active_page` | Последний активный таб | При переключении таба | При удалении конфига |
| `tt_theme` | Режим темы: `dark` / `light` / `system` | При смене темы | Никогда |
| `tt_language` | Язык UI: `ru` / `en` | При смене языка | Никогда |
| `tt_auto_connect` | Автоподключение VPN на старте (`"true"`/`"false"`) | Из настроек | Никогда |
| `tt_connected_since` | ISO-timestamp начала сессии VPN | При подключении | При отключении |
| `tt_config_cleared` | Флаг: пользователь вручную забыл конфиг | При "Forget config" | При импорте нового конфига |

> Префикс ключей — **`tt_`**, не `trusttunnel_`. Таблица в `CLAUDE.md` содержит устаревшие названия.

### TOML-конфиг VPN (`trusttunnel_client.toml`)

Файл лежит рядом с `.exe` (portable data dir, `gui-pro/src-tauri/src/ssh/mod.rs::portable_data_dir`). Автоопределяется по наличию секции `[endpoint]` или `[listener]` (`commands/config.rs::auto_detect_config`).

**Известные поля** (`ClientConfig` в `config.rs`):

| Поле | По умолчанию | Значения |
|------|--------------|----------|
| `loglevel` | `"info"` | `trace` / `debug` / `info` / `warn` / `error` |
| `vpn_mode` | `"general"` | `"general"` / `"proxy"` |
| `killswitch_enabled` | `true` | bool |
| `killswitch_allow_ports` | `[67, 68]` | Список u16. **DHCP-порты 67/68 автоматически добавляются** при любом save, чтобы Kill Switch не блокировал DHCP renewal |
| `post_quantum_group_enabled` | `true` | bool |

Неизвестные ключи сохраняются как есть (`#[serde(flatten)] extra` — C++ sidecar может читать поля, которых GUI не знает). Секции `[endpoint]` и `[listener]` обязательны — GUI отказывается сохранить конфиг без `endpoint`.

Дополнительные файлы в portable data dir: `known_hosts.json` (TOFU SSH fingerprints), `.sidecar.pid` (PID активного sidecar-процесса).

---

## 3. Tauri permissions (`src-tauri/capabilities/default.json`)

Окно `main` имеет следующие permissions:

- `core:default`
- `core:window:allow-minimize`, `allow-toggle-maximize`, `allow-close`, `allow-start-dragging`, `allow-is-maximized`, `allow-set-focus`
- `shell:default`, `shell:allow-execute`, `shell:allow-spawn`, `shell:allow-stdin-write`, `shell:allow-kill`
- `dialog:default` (выбор файлов через системный пикер)
- `notification:default`, `allow-notify`, `allow-request-permission`, `allow-is-permission-granted`
- `autostart:default` (запуск с Windows)

Плагин `window-state` и `single-instance` не требуют явных permissions — они активируются через `Builder::plugin(...)` в `lib.rs`.

---

## 4. Sidecar (`trusttunnel_client.exe`)

Запуск — через `tauri_plugin_shell::ShellExt::sidecar()` в `src-tauri/src/sidecar.rs::spawn_trusttunnel`.

**Флаги, которые передаёт GUI:**

```
trusttunnel_client -c <config_path> -l <log_level>
```

- `-c` — абсолютный путь до TOML-конфига
- `-l` — `trace` / `debug` / `info` / `warn` / `error`

**Логи:** stdout/stderr перехватываются и пишутся через `crate::logging::log_sidecar(...)` в файл лога приложения, а также эмитятся во фронтенд как события `vpn-log` (`{ message, level }`). Статус коннекта — событие `vpn-status` (`connecting` → `connected` → `disconnected` / `error`).

**Маркеры коннекта:** handshake (`"Successfully connected to endpoint"`) + DNS-proxy (`"DNS proxy listening"` или 10-секундный DNS-probe до `clients3.google.com`).

---

## 5. i18n

- Инициализация: `gui-pro/src/shared/i18n/index.ts`
- Поддерживаемые локали: **`ru`**, **`en`** (файлы `locales/ru.json`, `locales/en.json`)
- Fallback: `en`
- Определение языка на старте:
  1. `localStorage.tt_language` (явный выбор пользователя)
  2. Иначе `navigator.language` — `ru*` → `ru`, всё остальное → `en`
- Смена — через `useLanguage()` (записывает `tt_language`)

---

## 6. Тема

- Хук: `gui-pro/src/shared/hooks/useTheme.ts`
- Хранится в `localStorage.tt_theme`, значения: `"dark"` / `"light"` / `"system"` (default: `system`)
- В режиме `system` подписка на `window.matchMedia("(prefers-color-scheme: dark)")`
- Применяется через атрибут `data-theme` на `<html>`
- Переключение в Settings → General

---

## 7. Обновления

- Канал: **GitHub Releases** репозитория `ialexbond/TrustTunnelClientForWindows`
- Проверка — `gui-pro/src/shared/hooks/useUpdateChecker.ts`:
  - на старте приложения (silent)
  - далее каждые **6 часов** в фоне
  - вручную через AboutPanel → "Проверить обновления"
- Версия сравнивается с `tag_name` последнего релиза (с отбрасыванием pre-release суффикса)
- Ассет ищется по паттерну `/Pro.*setup.*\.exe$/i`; SHA256 — из файла `<asset>.sha256` или строки `SHA256: <hex>` в теле релиза
- Установка: `invoke("self_update", { downloadUrl, expectedSha256, language, theme })` — реализация в `src-tauri/src/commands/updater.rs`:
  - URL валидируется (только `github.com` / `objects.githubusercontent.com`, только HTTPS)
  - NSIS setup.exe скачивается во `%TEMP%/trusttunnel_setup.exe`
  - SHA256 проверяется; при несовпадении файл удаляется и обновление отменяется
  - Запускается `.bat`-скрипт: ждёт выход текущего PID → `setup.exe /S` → рестарт приложения
  - Параллельно — PowerShell-лоадер с прогресс-баром (cosmetic)
