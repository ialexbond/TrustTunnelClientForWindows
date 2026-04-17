<!-- generated-by: gsd-doc-writer -->
# Быстрый старт для разработчика

Этот документ проведёт вас от `git clone` до работающего окна Tauri-приложения в режиме
разработки. Цель — уложиться в 15 минут (не считая первой компиляции Rust, которая идёт дольше).

> Что такое TrustTunnel и зачем он нужен — см. [`README.md`](README.md).
> Как устроен код внутри — см. `ARCHITECTURE.md` <!-- VERIFY: ARCHITECTURE.md exists at repo root -->.
> Полный dev-workflow (линтеры, тесты, релизы) — см. `DEVELOPMENT.md` <!-- VERIFY: DEVELOPMENT.md exists at repo root -->.

---

## 1. Требования

| Инструмент | Версия | Примечание |
|---|---|---|
| **Windows** | 10 / 11 x64 | Другие ОС не поддерживаются (WinTUN, MSVC) |
| **Node.js** | LTS, `>= 18` | Vite 6 / Vitest 4 требуют современный Node |
| **Rust** | `>= 1.88` | Ставится через [`rustup`](https://rustup.rs/) |
| **MSVC toolchain** | `stable-x86_64-pc-windows-msvc` | `rustup default stable-x86_64-pc-windows-msvc` |
| **Visual Studio 2022 Build Tools** | с компонентом *Desktop development with C++* | Нужен линкер `link.exe` и Windows 10/11 SDK |
| **Git** | любая свежая | Для Windows удобно использовать Git Bash (инструкции ниже идут как bash-команды) |

Опционально, но рекомендуется:

- **WebView2 Runtime** — на Windows 11 установлен по умолчанию; для Windows 10 поставьте
  [Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

---

## 2. Клонирование и первый запуск

```bash
git clone https://github.com/ialexbond/TrustTunnelClientForWindows.git
cd TrustTunnelClientForWindows/gui-app

npm install
npm run tauri:dev
```

Что произойдёт:

1. `npm install` поставит фронтенд-зависимости (React 19, Vite, Tailwind, Storybook и т.д.).
2. `npm run tauri:dev` сначала поднимет Vite на `http://127.0.0.1:1420`, затем запустит
   `cargo build` для Rust-бэкенда и откроет окно Tauri.
3. **Первая компиляция идёт долго** — Cargo скачает и соберёт несколько сотен крейтов
   (`tauri`, `russh`, `tokio`, `reqwest` и др.). На современной машине 5–10 минут —
   это нормально. Последующие запуски занимают секунды благодаря `target/`-кэшу.

Horячая перезагрузка: React-код обновляется мгновенно, изменения в Rust
(`src-tauri/src/**`) перезапускают приложение автоматически.

---

## 3. Sidecar-бинарник (обязательно)

Rust-код ожидает, что рядом с ним лежит C++ sidecar `trusttunnel_client` и зависимые DLL.
Без них `cargo check` и `npm run tauri:dev` **не сработают** — Tauri проверяет
`externalBin` и `resources` из `tauri.conf.json`.

Требуемые файлы в `gui-app/src-tauri/`:

```text
trusttunnel_client-x86_64-pc-windows-msvc.exe
wintun.dll
vcruntime140.dll
vcruntime140_1.dll
```

### Вариант А — собрать из исходников (рекомендуется)

C++ sidecar собирается из корня репозитория через CMake + Ninja
(см. `README.md` → «Сборка из исходников»):

```bash
# из корня репо
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build --target trusttunnel_client

# скопировать бинарник под имя, которое ждёт Tauri
cp build/trusttunnel/trusttunnel_client.exe \
   gui-app/src-tauri/trusttunnel_client-x86_64-pc-windows-msvc.exe
```

DLL (`wintun.dll`, `vcruntime140*.dll`) берутся из апстрима —
см. [TrustTunnel Endpoint](https://github.com/TrustTunnel/TrustTunnel) и
[WinTUN](https://www.wintun.net).

### Вариант Б — скопировать из основного рабочего дерева (git worktree)

Если вы работаете в worktree и бинарники уже собраны в основном клоне:

```bash
# из worktree gui-app/
cp ../../../gui-app/src-tauri/trusttunnel_client-x86_64-pc-windows-msvc.exe src-tauri/
cp ../../../gui-app/src-tauri/wintun.dll src-tauri/
cp ../../../gui-app/src-tauri/vcruntime140.dll src-tauri/
cp ../../../gui-app/src-tauri/vcruntime140_1.dll src-tauri/
```

---

## 4. Две редакции

Pro (`gui-app/`) и Light (`gui-light/`) — это два отдельных Tauri-приложения в одном репо.
Инструкции идентичны, просто заходите в нужную папку:

```bash
cd gui-light
npm install
npm run tauri:dev
```

Light-версия не включает SSH-управление сервером, поэтому у неё меньше Rust-зависимостей
и заметно меньше скриптов (см. ниже).

---

## 5. Полезные скрипты

Из `gui-app/` (Pro) доступен полный набор:

```bash
npm run dev          # только Vite-фронт на :1420 (без Tauri-окна)
npm run tauri:dev    # полноценный Tauri dev с hot-reload
npm run build        # сборка фронта в dist/
npm run test         # vitest (все тесты, 1 прогон)
npm run typecheck    # tsc --noEmit (strict)
npm run lint         # ESLint с max-warnings 0
npm run rust:check   # cargo clippy -D warnings
npm run prerelease   # typecheck + lint + test + clippy + build — гоняйте перед PR
npm run storybook    # Storybook dev-сервер на :6006
npm run tauri build -- --bundles nsis   # NSIS-инсталлятор
```

Из `gui-light/` доступны только `dev`, `build`, `tauri`, `tauri:dev`, `typecheck`, `lint`
(нет тестов, Clippy и Storybook).

---

## 6. Troubleshooting

- **`cargo check` падает с "could not find `trusttunnel_client`"** — отсутствует sidecar.
  См. §3, положите `trusttunnel_client-x86_64-pc-windows-msvc.exe` и DLL в
  `gui-app/src-tauri/`.
- **`error: linker link.exe not found` / ошибки `LINK : fatal error`** — не установлен
  MSVC. Запустите Visual Studio Installer → «Build Tools for Visual Studio 2022» →
  компонент *Desktop development with C++* (включая Windows 10/11 SDK).
- **`rustc` ругается на цель `x86_64-pc-windows-gnu`** — у вас GNU-toolchain, а нужен MSVC:
  `rustup default stable-x86_64-pc-windows-msvc`.
- **Приложение стартует, но VPN не подключается** — вероятно, отсутствует `wintun.dll`
  или приложение запущено без прав администратора (WinTUN-адаптеру они нужны).
- **Первая сборка идёт 10+ минут** — это ожидаемо, Cargo компилирует ~сотни крейтов.
  Повторные сборки используют кэш `src-tauri/target/` и идут секунды.
- **`npm install` валится с EACCES / EPERM на Windows** — запустите терминал от имени
  администратора либо почистите `%APPDATA%\npm-cache`.
- **Порт 1420 занят** — остановите зависший процесс Vite (`taskkill /F /IM node.exe`)
  или поменяйте `server.port` в `gui-app/vite.config.ts`.

---

## Дальше

- Как устроен проект внутри — `ARCHITECTURE.md` <!-- VERIFY: ARCHITECTURE.md exists at repo root -->
- Ежедневный dev-workflow, линтеры, PR-процесс — `DEVELOPMENT.md` <!-- VERIFY: DEVELOPMENT.md exists at repo root -->
- Каталог UI-компонентов — `npm run storybook` в `gui-app/`
