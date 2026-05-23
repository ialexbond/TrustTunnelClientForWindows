<!-- generated-by: gsd-doc-writer -->
# CONFIGURATION

Справочник по настраиваемым параметрам TrustTunnel Client: что можно крутить во время сборки и во время работы. Документ описывает **какие ручки существуют** — не то, как устроена архитектура (см. `ARCHITECTURE.md`) и не то, как добавлять новые команды (см. `DEVELOPMENT.md`).

Все пути указаны относительно редакции **Pro** (`gui-pro/`); в Light (`gui-light/`) структура идентична, за вычетом серверного SSH-стека.

---

## 1. Build-time конфигурация

### `gui-pro/src-tauri/tauri.conf.json`

| Ключ | Значение | Описание |
|------|----------|----------|
| `productName` | `TrustTunnel Client Pro` | Имя продукта (отображается в инсталляторе и меню "Пуск") |
| `version` | `3.0.0` | Версия приложения (должна совпадать с `Cargo.toml` и `package.json`) |
| `identifier` | `com.trusttunnel.gui` | Bundle identifier (Light использует `com.trusttunnel.light`) |
| `app.windows[0].title` | `TrustTunnel Client for Windows Pro v3.0.0` | Заголовок главного окна |
| `app.windows[0].width` / `height` | `900` × `1000` | Стартовый размер окна |
| `app.windows[0].minWidth` / `maxWidth` | `800` / `1000` | Диапазон ширины (resizable, **но maxWidth = 1000**) |
| `app.windows[0].minHeight` | `1000` | Минимальная высота |
| `app.windows[0].maximizable` | `false` | Запрет maximize (контент cap'нут 1000px) |
| `app.windows[0].decorations` | `false` | Кастомный TitleBar (32 px) вместо стандартной рамки |
| `app.windows[0].shadow` | `true` | Системная тень вокруг окна |
| `app.windows[0].transparent` | `false` | Окно непрозрачное |
| `app.windows[0].backgroundColor` | `#0d0d0d` | Цвет фона до загрузки React |
| `app.windows[0].dragDropEnabled` | `false` | Drag-drop обрабатывается через HTML5 FileReader (Tauri-side disabled) |
| `app.windows[0].visible` | `false` | Стартует скрытым, окно показывается после первого React-render |
| `app.security.csp` | `null` | CSP выключен (окно — Tauri-shell, а не веб) |
| `bundle.externalBin` | `["trusttunnel_client"]` | Сайдкар-бинарник `trusttunnel_client-x86_64-pc-windows-msvc.exe` |
| `bundle.resources` | `wintun.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` | DLL, копируемые рядом с exe |
| `bundle.windows.nsis.languages` | `["Russian", "English"]` | Языки инсталлятора (кастомные `.nsh` в `nsis/`) |
| `bundle.windows.nsis.displayLanguageSelector` | `false` | Язык инсталлятора определяется по OS-locale, без диалога |
| `bundle.windows.nsis.installerHooks` | `nsis/installer-hooks.nsh` | NSIS-хуки (автозапуск, firewall, TAP-драйвер) |
| `bundle.windows.allowDowngrades` | `true` | Разрешает установку поверх более новой версии |
| `plugins.shell.open` | `true` | Разрешает `shell.open()` для внешних ссылок |

Dev-вариант — `tauri.dev.conf.json` (используется через `npm run tauri:dev`).

### `gui-pro/package.json` — scripts

| Script | Назначение |
|--------|-----------|
| `dev` | Vite dev-сервер (только фронтенд, порт `1420`) |
| `tauri:dev` | Tauri-приложение с hot reload (`tauri.dev.conf.json` override) |
| `build` | Vite production-сборка в `dist/` |
| `preview` | Vite preview built bundle |
| `typecheck` | `tsc --noEmit` (strict-режим) |
| `lint` | ESLint, `--max-warnings 0` |
| `test` | Vitest run |
| `test:watch` | Vitest watch-mode |
| `rust:check` | `cargo clippy -- -D warnings` |
| `rust:fmt` | `cargo fmt --check` |
| `prerelease` | Полный pipeline: typecheck + lint + test + clippy + build |
| `storybook` | Storybook dev-сервер на `:6006` |
| `build-storybook` | Static Storybook build |

### `gui-pro/src-tauri/Cargo.toml`

**Плагины Tauri 2:** `tauri-plugin-shell 2`, `tauri-plugin-dialog 2`, `tauri-plugin-window-state 2`, `tauri-plugin-single-instance 2.4.0`, `tauri-plugin-notification 2`, `tauri-plugin-autostart 2`. Tauri core — `tauri 2` с features `tray-icon`, `image-png`.

**Ключевые зависимости (Pro):** `russh 0.46` + `russh-keys 0.46` (SSH-клиент), `ssh-key 0.6` (Ed25519 generation, Phase 16), `tokio-rustls 0.26` + `rustls-pki-types 1` + `rustls-platform-verifier 0.6` (TLS cert probe, Phase 14.1), `reqwest 0.13.2` (HTTP), `notify 7` (file watcher), `keyring 3.6` (Windows credential manager, `windows-native` feature), `toml 0.8` + `toml_edit 0.22`, `tokio 1` (full), `winreg 0.55` (URL protocol HKCU), `ipconfig 0.3` + `socket2 0.5` (gateway probe), `sha2 0.10`, `base64 0.22`, `uuid 1` (v4 для heredoc-delimiter S-04), `rand 0.8` (exp-backoff jitter), `trusttunnel-settings` (local path к C++ sidecar shared schema, re-exports `trusttunnel-deeplink` TLV encoder).

**Light версия НЕ содержит:** `russh`, `russh-keys`, `ssh-key`, `tokio-rustls`, `rustls-pki-types`, `rustls-platform-verifier`, `keyring`, `winreg`, `rand`, `regex` (dev) — нет SSH-стека, нет cert probe, нет protocol registration.

**`[profile.release]`:** `strip = true`, `lto = true`, `codegen-units = 1`, `opt-level = "s"` — оптимизация по размеру, а не по скорости.

**Features:** `default = ["custom-protocol"]`, `devtools` (DevTools в сборке), `test` (Tauri test harness).

---

## 2. Runtime-конфигурация клиента

### localStorage (браузерное хранилище Tauri WebView)

Все ключи — с префиксом `tt_*` (НЕ `trusttunnel_*`). **Полная таблица — в `CLAUDE.md` §localStorage Keys** (источник истины). Здесь — краткое резюме категорий + что появилось в Phases 17–19.

**Категории:**
- **SSH-подключение:** `tt_ssh_last_host`, `tt_ssh_last_user`, `tt_ssh_last_port` — persist навсегда
- **Per-server auth:** `tt_auth_method_<host>` (`"key"` / `"password"`) — Phase 16, чистится только при `PermissionDenied` на auto-connect
- **VPN-конфиг:** `tt_config_path`, `tt_log_level`, `tt_auto_connect`, `tt_connected_since`, `tt_vpn_status`
- **UI-состояние:** `tt_active_page`, `tt_active_tab`, `tt_theme`, `tt_language`, `tt_feature_toggles`
- **Server-stats cache:** `tt_server_stats` (sessionStorage), `tt_geoip_<host>` (TTL-based)
- **Бенчмарки (Phase 17):** `tt_benchmark_<host>` — последние 5 результатов IP.Check.Place в JSON-массиве, никогда не очищается автоматически
- **Welcome (Phase 18):** `tt_welcome_completed` — флаг прохождения 3-screen онбординга; auto-skip также если `tt_ssh_last_host` уже есть (Pitfall 8)
- **Update dismissal (Phase 18):** `tt_dismissed_update_<version>` — per-version (auto-resets когда выходит более новая)
- **Update check timestamp (Phase 18):** `tt_last_update_check` — ISO timestamp последней background-проверки (24h cadence)
- **Wizard navigation:** `tt_navigate_after_setup` — целевой таб после wizard, очищается после навигации

**Phase 19 migration:** legacy `tt_active_tab = "utilities"` маппится на `"service"` в `loadActiveTab()` (`gui-pro/src/components/ServerTabs.tsx:56-72`) — следующий tab switch перезаписывает storage свежим id, миграционной записи нет.

### Клиентский TOML-конфиг VPN (`trusttunnel_client.toml`)

Файл лежит рядом с `.exe` (portable data dir, `gui-pro/src-tauri/src/ssh/mod.rs:119 portable_data_dir`). Автоопределяется по наличию секции `[endpoint]` или `[listener]` (`commands/config.rs::auto_detect_config`).

**Известные поля** (`ClientConfig` в `commands/config.rs:43-64`):

| Поле | По умолчанию | Значения |
|------|--------------|----------|
| `loglevel` | `"info"` | `trace` / `debug` / `info` / `warn` / `error` |
| `vpn_mode` | `"general"` | `"general"` / `"proxy"` |
| `killswitch_enabled` | `true` | bool |
| `killswitch_allow_ports` | `[67, 68]` | Список u16. **DHCP-порты 67/68 автоматически добавляются** при любом save (`ensure_dhcp_ports`), чтобы Kill Switch не блокировал DHCP renewal |
| `post_quantum_group_enabled` | `true` | bool |

Неизвестные ключи сохраняются как есть (`#[serde(flatten)] extra` — C++ sidecar может читать поля, которых GUI не знает). Секции `[endpoint]` и `[listener]` обязательны — GUI отказывается сохранить конфиг без `endpoint`.

**Path-traversal защита:** `validate_app_path()` в `commands/config.rs:11-31` канонизирует путь и проверяет, что он внутри `portable_data_dir()` — фронтенд не может попросить бэкенд прочитать произвольный файл.

### Дополнительные файлы в portable data dir

Файлы создаются рядом с `.exe` (`portable_data_dir()`):

- `client_config.toml` — VPN-конфиг (см. выше)
- `routing_rules.json` — domain / CIDR / GeoIP / process rules (Direct / Proxy / Block)
- `resolved/<rule_id>.txt` — DNS-resolved IPs per rule
- `geodata/geoip.dat` + `geodata/geosite.dat` — v2ray protobuf базы (с file-watcher на изменения)
- `activity.log` — application activity (D-29 invariant: пароли скрабятся)
- `app.log` — sidecar / system log (только если logging enabled)
- `known_hosts.json` — TOFU SSH fingerprints
- `.sidecar.pid` — PID активного sidecar-процесса
- `.start_minimized` — флаг автостарта в трей
- `.pending_deeplink` — буфер deep-link для cold-start

---

## 3. Серверная конфигурация (Pro only — читается через SSH)

> Сервер — Linux-машина под управлением Pro. Все нижеперечисленные файлы живут в **`/opt/trusttunnel/`** на сервере и читаются командой `server_get_config_bundle` (одним SSH-каналом, Phase 15.1). Полный путь — `gui-pro/src-tauri/src/ssh/mod.rs:87-90`.

| Константа (Rust) | Server-side path | Назначение |
|------------------|------------------|-----------|
| `ENDPOINT_DIR` | `/opt/trusttunnel` | Корень установки VPN endpoint |
| `ENDPOINT_BINARY` | `/opt/trusttunnel/trusttunnel_endpoint` | VPN sidecar daemon (бинарник) |
| `ENDPOINT_CONFIG` | `/opt/trusttunnel/vpn.toml` | Главный конфиг endpoint |
| `ENDPOINT_SERVICE` | `trusttunnel_endpoint` | <!-- VERIFY: name of systemd service unit on remote server — declared in code as ENDPOINT_SERVICE; actual `.service` file on disk (e.g. /etc/systemd/system/trusttunnel.service or trusttunnel_endpoint.service) lives on the remote VPS, not in this repo -->|

### 4 TOML-файла, читаемых `server_get_config_bundle`

Конфиг-таб в UI рендерит raw-content четырёх файлов в аккордеоны (Phase 15.1 — read-only). Структура `ConfigBundle` — `ssh/server/server_config.rs:61-71`.

| Файл | Описание | Доступ из UI |
|------|----------|---------------|
| `vpn.toml` | Главный конфиг endpoint (listen_address, ipv6_available, ping/speedtest paths, credentials_file, log_level, auth_failure_status_code, плюс catch-all `extra`) | Read-only raw view |
| `hosts.toml` | `[[main_hosts]]` blocks: `hostname` + `allowed_sni` whitelist. Hostname поднимается через certbot/Let's Encrypt | Read-only raw view |
| `credentials.toml` | Список пользователей VPN — `username` + `password` blocks. **Password lines маскируются на frontend** (regex) перед показом | Read-only raw view (masked) |
| `rules.toml` | Anti-DPI prefix rules per-user (Phase 14.1) — `[[rule]]` blocks с CIDR / SNI / username фильтрами | Read-only raw view; editable through individual user modals only |

**Schema-driven editor** (SchemaFieldRenderer / QuickSettingsCard / useTomlConfigState / SaveFlowDialog / NavigateAwayGuard) присутствует в коде как dead code — editing flow намеренно отключён в текущей итерации (Phase 15.1 UAT-driven pivot 2026-04-29).

**Whitelisted save command:** `server_save_config_file` (generic, `ssh/server/server_config.rs`) принимает только эти 4 имени файлов плюс char-whitelist validators (Layer 3 defence-in-depth для `rules.toml` CIDR-полей — `sanitize.rs:454+`).

### Прочие server-side артефакты (НЕ в `ConfigBundle`)

- `/opt/trusttunnel/users-advanced.toml` — TLV per-user advanced config (Phase 14.1) <!-- VERIFY: server-side path — declared in code as comment marker, persistence handled by users_advanced.rs -->
- `/etc/telemt/telemt.toml` — MTProto Proxy конфиг (Phase 17.1 — telemt rewrite). Поля: `[general.modes] tls = true`, `[general] use_middle_proxy = false`, `[server.api] enabled = true, listen = "127.0.0.1:9091"`, `[censorship] tls_domain = "<domain>", mask = true`, `[access.users] trusttunnel = "<hex-secret>"`. Renderer: `ssh/server/server_mtproto.rs:97-132 render_telemt_toml` <!-- VERIFY: /etc/telemt/ path on server is created by the install pipeline; the literal directory does not appear in this repo's source code outside of comments -->
- `/etc/systemd/system/trusttunnel.service` — systemd unit для VPN endpoint (Phase 18 sidecar update перезапускает через `systemctl restart trusttunnel`) <!-- VERIFY: actual systemd unit file path on remote server -->
- Let's Encrypt cert paths: стандартные `/etc/letsencrypt/live/<domain>/{fullchain,privkey}.pem` <!-- VERIFY: certbot-managed; not present in this repo, lives on remote server -->

---

## 4. Tauri permissions (`src-tauri/capabilities/default.json`)

Окно `main` имеет следующие permissions (источник — `gui-pro/src-tauri/capabilities/default.json`):

- `core:default`
- `core:window:allow-minimize`, `allow-toggle-maximize`, `allow-close`, `allow-start-dragging`, `allow-is-maximized`, `allow-set-focus`
- `shell:default`, `shell:allow-execute`, `shell:allow-spawn`, `shell:allow-stdin-write`, `shell:allow-kill`
- `dialog:default` (выбор файлов через системный пикер)
- `notification:default`, `notification:allow-notify`, `notification:allow-request-permission`, `notification:allow-is-permission-granted`
- `autostart:default` (запуск с Windows)

Плагины `window-state` и `single-instance` не требуют явных permissions — они активируются через `Builder::plugin(...)` в `lib.rs`. Плагин `window-state` использует **denylist** для окна `tray-menu` (dead reference из попытки сделать custom webview tray) — `lib.rs:62-75`.

---

## 5. Sidecar (`trusttunnel_client.exe`)

Запуск — через `tauri_plugin_shell::ShellExt::sidecar()` в `src-tauri/src/sidecar.rs:17-33`.

**Флаги, которые передаёт GUI:**

```
trusttunnel_client -c <config_path> -l <log_level>
```

- `-c` — абсолютный путь до TOML-конфига
- `-l` — `trace` / `debug` / `info` / `warn` / `error`

**Логи:** stdout/stderr перехватываются и пишутся через `crate::logging::log_sidecar(...)` в файл лога приложения, а также эмитятся во фронтенд как события `vpn-log` (`{ message, level }`). Статус коннекта — событие `vpn-status` (`connecting` → `connected` → `disconnected` / `error`).

**Маркеры коннекта:** handshake (`"Successfully connected to endpoint"`) + DNS-proxy (`"DNS proxy listening"` или 10-секундный DNS-probe до `clients3.google.com`).

**PID tracking:** `commands/vpn.rs:39 sidecar_pid_path()` пишется в `.sidecar.pid` (portable data dir), очищается на `CommandEvent::Terminated`. `kill_stale_sidecar()` запускается перед каждым новым коннектом, чтобы убрать осиротевшего после крэша. `kill_sidecar_from_state` убивает только child handle **этого** приложения — Pro и Light на одной машине сосуществуют, не убивая друг друга.

---

## 6. i18n

- Инициализация: `gui-pro/src/shared/i18n/index.ts`
- Поддерживаемые локали: **`ru`**, **`en`** (файлы `locales/ru.json`, `locales/en.json`)
- Fallback: `en`
- Определение языка на старте:
  1. `localStorage.tt_language` (явный выбор пользователя)
  2. Иначе `navigator.language` — `ru*` → `ru`, всё остальное → `en`
- Смена — через `useLanguage()` (записывает `tt_language`)
- **Phase 19** переименовала ~70 ключей `server.utilities.*` → `server.service.*` (canonical i18n структура; Wave 1 Plan 19-02)

---

## 7. Тема

- Хук: `gui-pro/src/shared/hooks/useTheme.ts`
- Хранится в `localStorage.tt_theme`, значения: `"dark"` / `"light"` / `"system"` (default: `system`)
- В режиме `system` подписка на `window.matchMedia("(prefers-color-scheme: dark)")`
- Применяется через атрибут `data-theme` на `<html>`
- Переключение в Settings → General

---

## 8. Обновления

TrustTunnel использует **dual update detection** (Phase 18 — REQ-18-UPDATE-DETECTION-01..04): отдельный канал для приложения и отдельный для серверного sidecar.

### App self-update (Pro setup.exe)

- **Канал:** GitHub Releases репозитория `ialexbond/TrustTunnelClientForWindows`
- **Проверка** — `gui-pro/src/shared/hooks/useUpdateChecker.ts`:
  - на старте приложения (silent)
  - далее каждые **24 часа** в фоне (`CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000`, было 6 часов до Phase 18 per D-2.4 / REQ-18-UPDATE-DETECTION-03)
  - вручную через AboutPanel → "Проверить обновления"
- **Версия:** сравнивается с `tag_name` последнего релиза (с отбрасыванием pre-release суффикса)
- **Ассет:** ищется по паттерну `/Pro.*setup.*\.exe$/i` (Light: `/Light.*setup.*\.exe$/i`)
- **SHA256:** из файла `<asset>.sha256` или строки `SHA256: <hex>` в теле релиза
- **Установка:** `invoke("self_update", { downloadUrl, expectedSha256, language, theme })` — реализация в `src-tauri/src/commands/updater.rs`:
  - URL валидируется (только `github.com` / `objects.githubusercontent.com`, только HTTPS — V9 allowlist в `validate_download_url`)
  - NSIS setup.exe скачивается во `%TEMP%/trusttunnel_setup.exe`
  - SHA256 проверяется; при несовпадении файл удаляется и обновление отменяется
  - Запускается `.bat`-скрипт: ждёт выход текущего PID → `setup.exe /S` → рестарт приложения
  - Параллельно — PowerShell-лоадер с прогресс-баром (cosmetic)
- **Per-version dismissal** (REQ-18-UPDATE-FLOW-02): `localStorage.tt_dismissed_update_<version> = "true"` после клика «X» на UpdateBanner. Auto-resets когда выходит более новая версия (per-version scope).
- **Audit timestamp:** `localStorage.tt_last_update_check` — ISO timestamp последней background-проверки (используется для 24h cadence rate-limit + debug visibility).

### Sidecar update (server-side `trusttunnel_endpoint`)

Phase 18 — atomic-swap update + rollback. Phase 19 — выбор конкретной версии из dropdown.

- **Канал:** GitHub Releases репозитория `TrustTunnel/TrustTunnel` (отдельный от Pro setup.exe)
- **Asset matching:** tarball `trusttunnel-v{TAG}-linux-{arch}.tar.gz`, **исключает `-dbgsym.tar.gz`** (10× меньше: 10.7 MB vs 107 MB) — `select_sidecar_asset` в `commands/updater.rs:122-143`
- **Pipeline (7 шагов):** `download_tarball` → `extract` → `backup` (`.bak`) → `swap` (`/opt/trusttunnel/trusttunnel_endpoint`) → `restart` (`systemctl restart trusttunnel`) → `verify` (6 × 2 s = 12 s window, `systemctl is-active`) → `complete`
- **Auto-rollback:** при `UPDATE_VERIFY_TIMEOUT` + `UPDATE_CANCELLED` (других кейсов нет — preserved partial state для idempotent retry per D-3.4)
- **Phase 19 — `list_sidecar_versions`** (`commands/updater.rs:438-499`): возвращает последние N non-prerelease tag'ов из GitHub Releases API, фильтруются через `validate_version` (S-02 char-whitelist) и `validate_download_url` (V9). Dropdown в ProtocolUpdateSection показывает максимум 4 версии (current + 3).
- **Surgical invariant** (REQ-18-UPDATE-FLOW-05): pipeline трогает **только** `/opt/trusttunnel/trusttunnel_endpoint` + `.bak` — НЕ касается `vpn.toml` / `credentials.toml` / certs / Let's Encrypt / certbot / `telemt` subsystem. Verified static-grep + 2 unit tests.

### Headers (для обоих каналов)

`Accept: application/vnd.github.v3+json` + `User-Agent: TrustTunnel-UpdateChecker` (требуется GitHub для unauthenticated requests). Анонимный access — токены не нужны.

---

## 9. Дизайн-система (CSS-токены)

`gui-pro/src/shared/styles/tokens.css` — **two-tier архитектура** (primitives → semantics), ~425 строк, ~243 CSS custom properties.

**Структура (Tier 1 + Tier 2):**

| Категория | Tokens | Примеры |
|-----------|--------|---------|
| Colors | ~154 | `--color-accent-50..900` (10 шагов), `--color-success/warning/danger/info-{400,500,600}`, semantic layers (`--color-bg-*`, `--color-text-*`, `--color-border-*`, `--color-status-*`, `--color-tint-*`) |
| Spacing | 8 | `--space-1..8` = 4/8/12/16/20/24/32/40 px |
| Radius | 5 | `--radius-sm/md/lg/xl/full` |
| Shadows | 5 + focus | `--shadow-xs..xl` + `--focus-ring` (double-ring keyboard focus) |
| Typography | ~32 | `--font-family-{sans,mono,display}`, `--font-size-*` (12/14/16/18/20/22/24/32/40/48 px), `--font-weight-{regular,medium,semibold,bold}`, `--line-height-*`, `--tracking-*` |

**Theme-aware:** все semantic-токены (`--color-bg-primary`, `--color-text-secondary`, etc.) переопределяются в `[data-theme="dark"]` блоке.

**Fonts:**
- **Geist Sans** + **Geist Mono** — variable, self-hosted woff2 в `gui-pro/src/shared/styles/fonts/`
- **Outfit** (wordmark «TrustTunnel» — AboutPanel / TitleBar) — Google Fonts CDN с offline fallback на Geist Sans
- **Twemoji Country Flags** — 78 KB woff2 в `gui-pro/public/fonts/` (Phase 15.1) для offline emoji-flag рендеринга на Overview

**Полные правила и decision tree:** см. memory deep-dives `memory/v3/design-system/{typography,spacing,shadows,colors,tokens}.md` + 4 MDX foundations в Storybook (`Foundations/Typography|Spacing|Shadows|Colors`).

---

## 10. Окружение / Secrets

**Никаких `.env` файлов и env-var-driven секретов.** Поиск `std::env::var` в `gui-pro/src-tauri/src/` находит только OS-level read'ы — `SystemRoot` (resolved системные DNS), `WEBVIEW2_USER_DATA_FOLDER` (data dir override), `current_exe()` для portable layout. Никаких API-токенов, OAuth credentials или secret-bearing env-переменных runtime не использует.

**Secrets at runtime:**
- **Windows Credential Manager** (через `keyring 3.6 windows-native`, под капотом DPAPI user-scope):
  - `save_ssh_credentials` / `load_ssh_credentials` — host + port + user + password (или key path)
  - `ssh_key_keyring_save_pem` / `..._load_pem` / `..._clear_pem` — Phase 16 Ed25519 PEM storage с namespaced service name (отдельный от password storage)
- **Никогда не в `activity.log`** (D-29 invariant — verified spy tests). Phase 18 расширил invariant на backend `emit_update_step` — только i18n keys / metadata, никаких paths или secrets.

**GitHub API:** анонимные v3 endpoints; требуется только `User-Agent` header. Никаких токенов в repo.

---

## 11. Cargo features

| Feature | Default | Описание |
|---------|---------|----------|
| `custom-protocol` | ✅ | `tauri/custom-protocol` — production-сборка с custom URI scheme handler |
| `devtools` | — | `tauri/devtools` — Chrome DevTools в Tauri webview (для отладки production-сборки) |
| `test` | — | `tauri/test` — Tauri test harness (для интеграционных тестов backend) |

Activated via `cargo build --features <name>`. NSIS production builds — без `devtools`.

---

*Configuration audit refreshed 2026-05-23 — reflects Phases 17.1 (telemt rewrite), 18 (sidecar update + welcome), 19 (Service tab rename + ProtocolUpdateSection + cascade-dot indicators). For client-side localStorage details see `CLAUDE.md` §localStorage Keys (canonical SSOT).*
