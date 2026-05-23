<!-- generated-by: gsd-doc-writer -->
# Быстрый старт для разработчика

Этот документ проведёт нового разработчика от `git clone` до работающего окна
Tauri-приложения в режиме разработки. Цель — уложиться в 15 минут (не считая
первой компиляции Rust, которая идёт дольше).

> **Что такое TrustTunnel и зачем он нужен** — [`README.md`](README.md).
> **Как устроен код внутри** — [`ARCHITECTURE.md`](ARCHITECTURE.md).
> **Все настройки сборки и runtime** — [`CONFIGURATION.md`](CONFIGURATION.md).
> **Ежедневный dev-workflow, линтеры, PR-процесс** — [`DEVELOPMENT.md`](DEVELOPMENT.md).
> **Правила дизайн-системы, gotchas, localStorage-ключи** — [`CLAUDE.md`](CLAUDE.md)
> (SSOT для AI/dev-guidance; этот документ ссылается, не дублирует).

---

## 1. Требования

| Инструмент | Версия | Примечание |
|---|---|---|
| **Windows** | 10 / 11 x64 | Другие ОС не поддерживаются (WinTUN, MSVC) |
| **Node.js** | LTS, `>= 20` | Vite 6 / Vitest 4 требуют современный Node; в проекте используется npm |
| **Rust** | `1.88` (закреплено) | См. `rust-toolchain.toml` в корне — `rustup` подхватит автоматически |
| **MSVC toolchain** | `stable-x86_64-pc-windows-msvc` | `rustup default stable-x86_64-pc-windows-msvc` (GNU не поддерживается) |
| **Visual Studio 2022 Build Tools** | компонент *Desktop development with C++* | Нужен линкер `link.exe` и Windows 10/11 SDK |
| **Tauri CLI** | `@tauri-apps/cli 2.x` | Поставляется как `devDependency` каждой редакции — отдельно ставить не нужно |
| **Git** | любая свежая | На Windows удобно через Git Bash (команды ниже — bash-синтаксис) |

Опционально, но рекомендуется:

- **WebView2 Runtime** — на Windows 11 установлен по умолчанию; для Windows 10
  поставьте [Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
- **PowerShell 7+** — большинство команд работают и в `cmd.exe`, но скрипты
  в `scripts/` (Python + PS) удобнее запускать из современного шелла.

> Версии Node, TypeScript, React, Tauri и все рантайм-зависимости задокументированы
> в [`.planning/codebase/STACK.md`](.planning/codebase/STACK.md) (обновлён 2026-05-23).

---

## 2. Клонирование и первый запуск

```bash
git clone https://github.com/ialexbond/TrustTunnelClientForWindows.git
cd TrustTunnelClientForWindows/gui-pro

npm install
npm run tauri:dev
```

Что произойдёт:

1. `npm install` поставит фронтенд-зависимости (React 19, Vite 6, Tailwind 3,
   Storybook 10, `@tauri-apps/cli`, vitest и т.д.) — это и подтянет Tauri CLI
   как локальный бинарь.
2. `npm run tauri:dev` поднимет Vite на `http://127.0.0.1:1420`, запустит
   `cargo build` для Rust-бэкенда (`gui-pro/src-tauri/`) и откроет окно Tauri.
3. **Первая компиляция идёт долго** — Cargo скачает и соберёт несколько сотен
   крейтов (`tauri`, `russh`, `tokio`, `reqwest`, `ssh-key`, `tokio-rustls`,
   `keyring`, и др.). На современной машине 5–10 минут — это нормально.
   Повторные запуски занимают секунды благодаря `target/`-кэшу.

Горячая перезагрузка: React-код обновляется через Vite HMR; изменения в Rust
(`src-tauri/src/**`) перезапускают приложение автоматически (HMR Vite принудительно
отключён в `vite.config.ts`, т.к. VPN перенастраивает сетевой стек).

---

## 3. Sidecar-бинарник + DLL (обязательно)

Tauri ожидает, что рядом с Rust-бэкендом лежит C++ sidecar `trusttunnel_client`
и зависимые DLL. Без них `cargo check` и `npm run tauri:dev` **не сработают** —
Tauri валидирует `externalBin` и `resources` из `tauri.conf.json` на этапе сборки.

Требуемые файлы в `gui-pro/src-tauri/`:

```text
trusttunnel_client-x86_64-pc-windows-msvc.exe
wintun.dll
vcruntime140.dll
vcruntime140_1.dll
```

Все четыре файла **gitignored** — их нет ни в основном клоне после `git clone`,
ни в worktree.

### Вариант А — собрать sidecar из исходников (рекомендуется для maintainer'ов)

C++ sidecar собирается из апстрим-репозитория
[`TrustTunnel/TrustTunnel`](https://github.com/TrustTunnel/TrustTunnel) через
CMake + Ninja. После сборки положите бинарник под именем
`trusttunnel_client-x86_64-pc-windows-msvc.exe` в `gui-pro/src-tauri/`.

DLL (`wintun.dll` из [WinTUN](https://www.wintun.net), `vcruntime140*.dll` из
Visual C++ Redistributable) — туда же.

### Вариант Б — скопировать из основного checkout (рабочий поток в worktree)

Если вы работаете в git worktree (например, `.claude/worktrees/<branch>/`)
и в основном клоне `~/Documents/TrustTunnelClient/` бинарники уже лежат —
точные команды копирования описаны в **[`CLAUDE.md` §Worktree Setup](CLAUDE.md#worktree-setup)**.
Не дублируем их здесь, чтобы не разъехаться при обновлении.

После копирования sidecar — `cd gui-pro && npm install && npm run build`,
и можно запускать `npm run tauri:dev`.

---

## 4. Две редакции — Pro и Light

`gui-pro/` (Pro) и `gui-light/` (Light) — два отдельных Tauri-приложения в одном
монорепо. **Корневого `package.json` нет** (это не npm-workspaces), каждая
редакция собирается из своего каталога:

```bash
cd gui-light
npm install
npm run tauri:dev
```

Light-версия не включает SSH-управление сервером, поэтому у неё меньше Rust-зависимостей
(нет `russh`, `keyring`, `tokio-rustls`) и заметно урезанный набор npm-скриптов
(нет тестов, Clippy, Storybook). Различия между Pro и Light зафиксированы в
[`ARCHITECTURE.md` §2](ARCHITECTURE.md).

---

## 5. Полезные скрипты

**Канонический список команд** — в [`CLAUDE.md` §Build Commands](CLAUDE.md#build-commands)
(SSOT). Ниже — самые частые при первом знакомстве:

```bash
# Pro (из gui-pro/)
npm run tauri:dev    # полноценный Tauri dev с hot-reload
npm run dev          # только Vite-фронт на :1420 (без Tauri-окна, удобно для UI-работы)
npm run test         # vitest (один прогон всех тестов)
npm run typecheck    # tsc --noEmit (strict)
npm run lint         # ESLint, max-warnings 0
npm run storybook    # Storybook на :6006 — визуальный каталог компонентов
npm run prerelease   # typecheck + lint + test + clippy + build — обязательно перед PR
```

Из `gui-light/` доступны только `dev`, `build`, `tauri`, `tauri:dev`, `typecheck`,
`lint` (нет тестов, Clippy и Storybook).

---

## 6. Что вы увидите при первом запуске

После `npm run tauri:dev`:

1. Окно 900×1000 с кастомным TitleBar (32 px) и нижним bottom tab bar
   (5 pill-кнопок: Подключение / Панель управления / Маршрутизация / Настройки / О программе).
2. **Phase 18 — Welcome Tour** (новые пользователи без `localStorage.tt_ssh_last_host`):
   3-screen onboarding overlay поверх окна. Можно пролистать (стрелки слева/справа,
   как в Instagram-carousel) либо закрыть «X» в правом верхнем углу. Флаг
   `tt_welcome_completed` ставится после закрытия и больше не показывается.
3. **Существующие пользователи** (есть сохранённый `tt_ssh_last_host`) — overlay
   автоматически пропускается (auto-skip captured snapshot, Pitfall 8 mitigation
   в `useWelcomeTour`).
4. Активным открывается таб «Подключение» (либо тот, что лежит в `localStorage.tt_active_page`).

### Аутентификация в Pro (опционально, для серверной панели)

Pro-редакция умеет управлять Linux-сервером через SSH. Чтобы попробовать:

1. Перейдите на таб **«Панель управления»**.
2. Заполните `SshConnectForm`: host / port / user / password ИЛИ путь к
   приватному ключу. Phase 16 добавила Ed25519 keypair generation и хранение
   PEM-приватника в Windows Credential Manager (через `keyring 3.6`).
3. Per-server preference хранится в `localStorage.tt_auth_method_<host>`
   (`"key"` / `"password"`).
4. После успешного коннекта откроется `ServerPanel` с 5 табами:
   Обзор / Пользователи / Конфигурация / Безопасность / Сервис (Phase 19 rename
   «Утилиты» → «Сервис»).

> Light-редакция не содержит SSH-стека — она только импортирует TOML/deep-link
> конфиг и поднимает туннель через sidecar.

---

## 7. Troubleshooting

- **`cargo check` падает с "could not find `trusttunnel_client`"** — отсутствует sidecar.
  См. §3, положите `trusttunnel_client-x86_64-pc-windows-msvc.exe` и DLL в
  `gui-pro/src-tauri/` (либо скопируйте из основного checkout по
  [`CLAUDE.md` §Worktree Setup](CLAUDE.md#worktree-setup)).
- **`error: linker link.exe not found` / `LINK : fatal error`** — не установлен
  MSVC. Запустите Visual Studio Installer → «Build Tools for Visual Studio 2022» →
  компонент *Desktop development with C++* (включая Windows 10/11 SDK).
- **`rustc` ругается на цель `x86_64-pc-windows-gnu`** — у вас GNU-toolchain,
  а нужен MSVC: `rustup default stable-x86_64-pc-windows-msvc`. Затем
  `rustup show` должен показать активный канал `1.88` (из `rust-toolchain.toml`).
- **Приложение стартует, но VPN не подключается** — вероятно, отсутствует `wintun.dll`
  или приложение запущено без прав администратора (WinTUN-адаптеру они нужны
  для создания TUN-интерфейса).
- **Первая сборка идёт 10+ минут** — это ожидаемо, Cargo компилирует ~сотни крейтов.
  Повторные сборки используют кэш `src-tauri/target/`.
- **`npm install` валится с EACCES / EPERM на Windows** — запустите терминал
  от имени администратора либо почистите `%APPDATA%\npm-cache`.
- **Порт 1420 занят** — остановите зависший процесс Vite (`taskkill /F /IM node.exe`)
  или поменяйте `server.port` в `gui-pro/vite.config.ts`.
- **Welcome Tour не показывается, хотя `localStorage` пустой** — проверьте
  `tt_ssh_last_host`: если он есть (например, от прошлого запуска Pro),
  тур auto-skip'ится. Очистите ключ через DevTools (`devtools` feature
  в Cargo, см. [`CONFIGURATION.md` §11](CONFIGURATION.md)).

---

## 8. Куда смотреть, если застрял

Знание спрятано в нескольких слоях — открывайте по нарастанию глубины:

1. **[`CLAUDE.md` §Gotchas](CLAUDE.md#gotchas)** — частые ловушки React 19 / Tauri 2 /
   Tailwind / Storybook (inline-style побеждает hover, `if (!isOpen) return null`
   до `<Modal>`, SSH channel stampede, hover-state stuck после `window.hide()`).
2. **[`CLAUDE.md` §Critical Rules](CLAUDE.md#critical-rules)** —
   master read-only, version bump checklist, NSIS-инсталляторы, tray menu.
3. **[`CLAUDE.md` §Security Rules](CLAUDE.md#security-rules)** — char-whitelist,
   D-29 invariant (пароли не в `activity.log`), SSH heredoc UUID-delimiters.
4. **[`.planning/codebase/`](.planning/codebase/)** (карта кода, обновлена 2026-05-23):
   - [`STACK.md`](.planning/codebase/STACK.md) — точные версии всех зависимостей
   - [`ARCHITECTURE.md`](.planning/codebase/ARCHITECTURE.md) — модули с LOC и потоками данных
   - [`STRUCTURE.md`](.planning/codebase/STRUCTURE.md) — дерево каталогов
   - [`CONVENTIONS.md`](.planning/codebase/CONVENTIONS.md) — соглашения и паттерны
   - [`CONCERNS.md`](.planning/codebase/CONCERNS.md) — известные тех.долги и анти-паттерны
   - [`TESTING.md`](.planning/codebase/TESTING.md) — стратегия тестов
   - [`INTEGRATIONS.md`](.planning/codebase/INTEGRATIONS.md) — внешние сервисы (GitHub API, certbot, telemt)
5. **`memory/v3/`** (gitignored граф знаний) — углублённые design-decisions:
   - `memory/v3/design-system/{typography,spacing,shadows,colors,tokens}.md` — foundations
   - `memory/v3/screens/control-panel-{overview,security,service}.md` — серверные табы
   - `memory/v3/screens/{onboarding,update-flow}.md` — Phase 18/19 onboarding и обновления
   - `memory/v3/components-catalog.md` — реестр shared UI (~36) + screen-уровневых компонентов
6. **Каталог UI** — `npm run storybook` в `gui-pro/` (40+ story-файлов, Foundations
   через MDX-страницы: Typography / Spacing / Shadows / Colors).

---

## Дальше

- Архитектура и потоки данных — [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Конфигурация (build-time + runtime + сервер + локализация) — [`CONFIGURATION.md`](CONFIGURATION.md)
- Ежедневный dev-workflow, линтеры, PR-процесс — [`DEVELOPMENT.md`](DEVELOPMENT.md)
- Тесты и фреймворки — [`TESTING.md`](TESTING.md)
- Правила контрибуции — [`CONTRIBUTING.md`](CONTRIBUTING.md)
