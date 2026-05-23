<!-- generated-by: gsd-doc-writer -->
# Development

Этот документ — рабочая методичка для активного разработчика, который вносит изменения
в кодовую базу TrustTunnel Client. Он описывает дневные циклы, дисциплину git/qualified-veneer,
правила работы с дизайн-системой, паттерны добавления Tauri-команд и подводные камни,
которые накопились за фазы 14–19.

Первый запуск и установка зависимостей — в [GETTING-STARTED.md](GETTING-STARTED.md).
Общая архитектура — в [ARCHITECTURE.md](ARCHITECTURE.md). Конфигурация и токены — в
[CONFIGURATION.md](CONFIGURATION.md). Правила тестирования — в [TESTING.md](TESTING.md).
**[CLAUDE.md](CLAUDE.md) — источник правды** для дизайн-системы, security-инвариантов
и gotchas; этот файл ссылается на него, а не дублирует.

## 1. Ежедневный workflow

### Бранчевая модель

- **`master` — READ-ONLY.** Никаких commit/merge без явного запроса. См.
  [CLAUDE.md → Critical Rules](CLAUDE.md#critical-rules) и G-01 в
  [`.planning/codebase/CONCERNS.md`](.planning/codebase/CONCERNS.md).
- Релизные ветки: `release/tt-win-X.Y.Z`. На момент 2026-05-23 актуальная — `release/tt-win-3.0.0`.
- AI/feature-ветки живут в worktree-директориях `.claude/worktrees/*` на ветках
  `claude/*`. Это даёт изолированные рабочие копии и не блокирует основной checkout.

Проверить текущий worktree и его ветку:

```bash
git worktree list
git branch --show-current
```

### Качественные ворота

Каждое значимое изменение должно проходить:

```bash
# Из gui-pro/
npm run typecheck      # tsc --noEmit (strict mode)
npm run lint           # ESLint, max-warnings 0
npm run test           # Vitest, все тесты
npm run rust:check     # cargo clippy -D warnings (через cd src-tauri)
```

Запускается одной командой:

```bash
npm run prerelease     # typecheck + lint + test + rust:check + build
```

**Дисциплина:**

- TypeScript — strict mode включён, `any` запрещён, `unknown` + сужение типов вместо приведений.
- ESLint — `max-warnings 0`. Любое новое предупреждение блокирует CI.
- `cargo clippy -D warnings` — на новом Rust-коде. Есть ~83 pre-existing baseline-предупреждений
  (TD-06 в CONCERNS.md), которые не сметены — новые добавлять нельзя.
- Перед каждым релизом: `cd gui-pro/src-tauri && cargo audit`. Ожидаемо 1 vuln (RUSTSEC-2023-0071)
  + 23 maintenance warnings (gtk-rs, Linux-only path) — см. [SECURITY.md](SECURITY.md).

### Версионный bump

Версии живут в **6 файлах в lockstep** — пропускать нельзя:

1. `gui-pro/package.json`
2. `gui-pro/src-tauri/Cargo.toml`
3. `gui-pro/src-tauri/tauri.conf.json`
4. `gui-light/package.json`
5. `gui-light/src-tauri/Cargo.toml`
6. `gui-light/src-tauri/tauri.conf.json`

На 2026-05-23: фазы 16–19 разделяют один релиз-тег 3.0.0 — Pro остаётся `3.0.0`, Light `2.7.0`,
никаких per-phase инкрементов по решению владельца проекта.

## 2. Frontend dev-loop

Два режима запуска фронтенда — выбор зависит от того, нужен ли Rust-бэкенд.

```bash
# Из gui-pro/ (или gui-light/)
npm run dev          # Vite dev-сервер на http://127.0.0.1:1420 (браузер, без Tauri)
npm run tauri:dev    # Полноценное окно Tauri с Rust-бэкендом
```

**`npm run dev`** — самый быстрый цикл для UI-работы (~200 мс reload). Все `invoke("…")`-вызовы
в браузере вернут ошибку — это нормально, мокать не требуется, если экран не зависит от данных от Rust.

**`npm run tauri:dev`** — когда нужен реальный ответ от Rust (SSH, VPN, конфиги, сеть) либо
системные интеграции (трей, deep-link `tt://`, автозапуск). **Vite HMR принудительно выключен**
(`gui-pro/vite.config.ts:28 hmr: false`) — VPN-подключение меняет сеть и HMR-рефреши ломают
dev-сессию. После правок фронта в `tauri:dev` — ручной reload (Ctrl+R в окне). Включать HMR
обратно не нужно (W-05 в CONCERNS.md).

## 3. Backend dev-loop (Rust)

Rust-код в `gui-pro/src-tauri/src/`. Структура каталогов:

- `commands/` — 94 Tauri-команды в 10 модулях (`activity_log.rs`, `config.rs`, `deeplink.rs`,
  `geoip.rs`, `history.rs`, `network.rs`, `protocol.rs`, `ssh_commands.rs`, `updater.rs`, `vpn.rs`).
- `ssh/` — connection pool, `russh`-клиент, `sanitize.rs` валидаторы, `mod.rs:CHANNEL_OPEN_GATE`.
- `ssh/server/` — модули server-side инсталляторов (install, mtproto, update, ssh-key, rules, …).
- `lib.rs` — Tauri setup, `tauri::generate_handler![…]` регистрация, трей, окно.

```bash
# Из gui-pro/src-tauri/
cargo check             # Быстрая проверка типов без линковки (~5–15 с после первой сборки)
cargo clippy -D warnings  # Линтер (то же, что npm run rust:check)
cargo fmt --check       # Форматирование
```

**Практика:**

- `cargo check` быстрее, чем ждать перезапуск `tauri dev`. Используйте его, пока не готовы
  проверить IPC целиком.
- Изменения в `commands/*.rs` требуют **перезапуска** `npm run tauri:dev` — пересборка через
  watcher запустится, но handler-таблица регистрируется при старте, новые команды на лету
  не подхватятся.
- Первая сборка ~5 минут на холодном cache. Последующие — 30–60 секунд.
- В worktree перед первым `cargo check` скопируйте sidecar + DLL (раздел 9).

## 4. Контрибуция в дизайн-систему

Дизайн-система описана декларативно в [CLAUDE.md → Design System Rules](CLAUDE.md#design-system-rules);
deep-dives — `memory/v3/design-system/{typography,spacing,shadows,colors}.md` (gitignored).
Этот раздел — операционная сводка, не дубль; **при противоречии источник истины — CLAUDE.md**.

### Цвета (Phase 14.2 + post-rewrite)

- 89 токенов в `gui-pro/src/shared/styles/tokens.css`, 7 функциональных слоёв (accent / bg /
  text / border / input / status / tint). **Никаких hex в компонентах.** `gui-pro/src/shared/colors.ts`
  удалён в v3.0 — не возвращать (G-12).
- Использовать через bracket-notation: `text-[var(--color-*)]`, `bg-[var(--color-*)]`. **Tailwind
  native** типа `text-red-500` запрещены.
- Только семантические токены: не `--color-success-400`, а `--color-status-connected`.
- 10% accent-rule: accent — только для интерактивных элементов.
- Для кнопок с цветной заливкой (primary/danger/...) — `text-white`, **не**
  `text-[var(--color-text-inverse)]` (в тёмной теме это чёрный — G-13).

### Типографика (Phase 14.2, v2)

- 14 семантических composite-классов: `text-caption / body-sm / body / body-lg / subtitle /
  button / title-sm / title / title-lg / display-sm / display / wordmark / mono / mono-sm`.
  Они применяют family+size+weight+leading атомарно.
- **Предпочитать composite-классы**: `<h2 className="text-title">` вместо
  `text-lg font-semibold leading-snug`. Manual-комбинации — только для оттенков,
  не покрытых composites.
- Family rule: **labels — sans, values — mono**. IP/SHA/числовая статистика/единицы (`42 ms`,
  `124 Мбит/с`) — целиком `font-mono`. Wordmark «TrustTunnel» — `font-display`.
- Weight rule: `font-medium` — buttons/form-labels/tabs/chips; `font-semibold` — headings/titles;
  `font-bold` — только display/wordmark.
- **Запрещено** (вычищено в Plan 14.2 strict compliance):
  - `font-[var(--font-weight-*)]`
  - `text-[var(--font-size-*)]` — Tailwind генерирует `color:`, а не `font-size:` (G-11)
  - inline `style={{ fontSize }}`
  - Tailwind arbitrary `text-[Npx]` (`text-[11px]`, `text-[13px]`), обходящий шкалу

### Shadows (5-уровневая elevation)

- `--shadow-xs..xl` = flat-plus / flat / raised / floating / deep + `--focus-ring` (double-ring
  keyboard focus).
- Подключение: `shadow-[var(--shadow-N)]` либо inline `style={{ boxShadow: "var(--shadow-N)" }}`.
  Tailwind native `shadow-sm/md/lg/xl` — НЕ использовать (разная rgba).
- Mapping: Card = sm, Modal = lg, Dropdown/Tooltip = md, deep modal = xl, focus states = `--focus-ring`.
- **Никаких glow / colored tint** в shadow — это визуальный шум. Двух-слойные тени, произвольная
  rgba, tint-based focus accent — запрещены.

### Spacing (4px база)

- 8 токенов: `--space-1..8` = 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40.
- Tailwind `p-1..6 / m-1..6 / gap-1..6` матчат `--space-1..6` напрямую. Для 32/40 —
  bracket-notation `p-[var(--space-7)]` / `p-[var(--space-8)]`. **Не** `p-7`/`p-8`/`p-10`
  Tailwind native (там другие значения — naming collision).
- Anti-patterns: `p-[13px]` (не кратное 4), inline `style={{ padding }}`, magic-numbers в CSS.

### Критический Phase 14 finding — inline color перебивает hover

Inline `style={{ color: "var(--token)" }}` имеет более высокую CSS-specificity, чем
утилитные классы Tailwind. `hover:text-*` / `focus:text-*` / `disabled:text-*` **молча
не работают** — inline всегда побеждает.

```tsx
// БАГ: hover не сработает
<Icon style={{ color: "var(--color-danger-500)" }} className="hover:text-accent" />

// ПРАВИЛЬНО: базовый цвет — в bracket-notation
<Icon className="text-[var(--color-danger-500)] hover:text-accent" />
```

Inline-style оставлять **только** для динамических вычислений (paddingRight, getBoundingClientRect-position).
Кейсы исправлений в Phase 14: `UsersSection.tsx`, `UsersAddForm.tsx`, `UserConfigModal.tsx` —
см. G-06 в CONCERNS.md.

Связанный гетча: `transition-colors` **не транзитит opacity** — `hover:opacity-70` снапит
мгновенно. Используйте `transition-opacity` или `transition-all` (G-07).

### Слияние классов

Всегда через `cn()` из `gui-pro/src/shared/lib/cn.ts`. Она расширяет `tailwind-merge`
кастомной группой `font-size` (включает все семантические composites), чтобы конфликт
размеров разрешался корректно при override.

### Storybook story — обязательна

Любой новый или изменённый компонент в `shared/ui/` или нетривиальная панель в `components/`
**должны** иметь `.stories.tsx`. Baseline: **65 story-файлов в `gui-pro/src/`** (37 в
`shared/ui/`, 24 в `components/`, остальные — foundations). Storybook на `:6006`:

```bash
npm run storybook
```

Интерактивные stories используют `useState` внутри `render()` либо `play()` из `storybook/test`
(`userEvent` + `within` + `waitFor`).

**Tauri mocks** в `.storybook/tauri-mocks/` — 6 файлов (`api-app`, `api-core`, `api-event`,
`api-window`, `plugin-dialog`, `plugin-shell`). Vite-алиасы в `.storybook/main.ts` подменяют
реальные импорты на моки, так что `invoke("…")` в компонентах возвращает детерминированные
данные. **Не удалять и не ломать** — стори крашатся (W-04).

**MDX foundations** (Typography / Spacing / Shadows / Colors): canonical 5-step pattern —
MDX docs + stories file + memory deep-dive + tokens.md section + CLAUDE.md paragraph.
При добавлении нового foundation (Animations / Iconography / Motion) — следовать всем
5 шагам. Декларативно, не state/history. См. [CLAUDE.md → Storybook Foundations pattern](CLAUDE.md#storybook-foundations-pattern).

Контрастный фикс в `.storybook/storybook-overrides.css` (`.sbdocs` scope) **не удалять** —
без него MDX docs-страницы теряют читаемость (G-03).

## 5. Добавление Tauri-команды

Команды живут в `gui-pro/src-tauri/src/commands/<module>.rs`. Минимальный цикл:

### Шаг 1. Определить команду в Rust

```rust
// gui-pro/src-tauri/src/commands/network.rs
#[tauri::command]
pub async fn health_check(host: String, port: u16) -> Result<serde_json::Value, String> {
    // ... логика
    Ok(serde_json::json!({ "ok": true, "latency_ms": 42 }))
}
```

### Шаг 2. Зарегистрировать в `lib.rs`

```rust
// gui-pro/src-tauri/src/lib.rs
.invoke_handler(tauri::generate_handler![
    // ... существующие команды
    commands::network::health_check,
])
```

Регистрация — на старте; **перезапустите** `npm run tauri:dev` после добавления.

### Шаг 3. Валидация ввода — char-whitelist, всегда

**Любое поле, попадающее в shell-команду, обязано быть провалидировано через `gui-pro/src-tauri/src/ssh/sanitize.rs`.**
Whitelist, не blacklist. Активный реестр валидаторов с маппингом fields → whitelists —
в [`.planning/codebase/CONCERNS.md`](.planning/codebase/CONCERNS.md) §S-02 (например
`validate_vpn_username`, `validate_vpn_password`, `validate_cidr`, `validate_tls_domain`,
`validate_version`, `validate_download_url`).

Добавляешь новое поле deeplink/credentials/config — добавь парный валидатор. Phase 14.1 review
закрыл два gap’a (CR-02/CR-03), вызванных пропуском этого шага.

### Шаг 4. Если команда выполняется по SSH — heredoc через UUID-делимитеры

Multi-line SSH-команды используют random `EOF_<uuid>` маркеры, **не статичные** `USER_EOF`:
username/password/version могут легально содержать маркер → break shell-parsing или injection.

Эталоны: `gui-pro/src-tauri/src/ssh/server/server_install.rs`, `users_advanced.rs`,
`server_mtproto.rs` (Phase 17.1), `server_update.rs` (Phase 18 — `format!("UPD_DL_{}", uuid::Uuid::new_v4().simple())`).
См. S-04 в CONCERNS.md.

### Шаг 5. Если команда дёргает пул SSH — учесть CHANNEL_OPEN_GATE

В `gui-pro/src-tauri/src/ssh/mod.rs:437–489` глобальный лимитер
`static CHANNEL_OPEN_GATE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(5))`
физически каппает параллельные `channel_open_session()` до 5. Поверх — retry exp-backoff
6 attempts × 50/100/200/400/800 мс + 0–99 мс jitter (~1.8 с total).

**Не повышать permit выше 6–7** — нужен headroom для keepalive + ad-hoc kill-sidecar.
Симптом без gate: snackbar `SSH_CHANNEL_FAILED | Failed to open channel (ConnectFailed)`
через ~400 мс после `panel.load.completed` при логине в новый сервер. См. G-05 в CONCERNS.md.

### Шаг 6. D-29 invariant — никаких секретов в `activity.log`

Пароли / PEM-bytes / telemt `secret` / `proxy_link` / binary paths в update flow **никогда**
не попадают в `activity.log`, в `emit_log_*`, в DOM, в `console.warn`.

Любой компонент, обрабатывающий чувствительные данные, **обязан** иметь spy-тест:

```ts
expect(log).not.toHaveBeenCalledWith(expect.stringContaining(password));
```

Активные spy-assertion sites (cumulative, Phase 14+):

- `PasswordRotationPrompt.test.tsx` — пароль в payload/message
- `UsersSection.test.tsx` — bulk operations
- `UserModal.test.tsx` — user creation flow
- `SshKeyModal.test.tsx` — 4 спая на PEM body (Phase 16)
- `MtProtoModal.test.tsx` — tests 8/9: telemt secret + proxy_link (Phase 17.1)
- `UpdateProgressModal.test.tsx` — 3 спая: DOM password / DOM `.bak`/paths / `console.warn`
- `ProtocolUpdateSection.test.tsx` — Phase 19, 3 спая (включая GitHub asset URL leak)

**Ловушка:** `formatError(e)` может содержать SSH stderr, который эхает пароль —
strip-pattern обязателен. См. S-03 в CONCERNS.md и [memory/security-posture.md](memory/security-posture.md).

### Шаг 7. Binary payload — base64

`Vec<u8>` через serde сериализуется как `number[]` на TS-стороне — это ABI-mismatch ловушка.
Все бинарные поля (cert DER, key bytes) **обязательно** через `leaf_der_b64: String` на обеих
сторонах. См. S-05 в CONCERNS.md.

### Шаг 8. Вызов из фронтенда

```ts
import { invoke } from "@tauri-apps/api/core";

interface HealthCheckResult {
  ok: boolean;
  latency_ms: number;
}

const result = await invoke<HealthCheckResult>("health_check", {
  host: "example.com",
  port: 443,
});
```

Имена параметров в `invoke(...)` — **snake_case**, как в Rust-сигнатуре. Tauri конвертирует
в camelCase на TS-стороне только для возвращаемых значений, если структура помечена
`#[serde(rename_all = "camelCase")]`.

### Шаг 9. Обратный канал (Rust → Frontend) — события

```rust
app.emit("vpn-status", VpnStatusPayload { status: "connected".into(), error: None })?;
```

```ts
import { listen } from "@tauri-apps/api/event";
const unlisten = await listen<VpnStatusPayload>("vpn-status", (e) => {
  console.log(e.payload);
});
```

## 6. Modal lifecycle (Phase 14 post-install finding)

`gui-pro/src/shared/ui/Modal.tsx` управляет своим lifecycle через `mounted` + `animating` state
с 200 мс exit-fade. **Не делать `if (!isOpen) return null` в parent-компоненте перед `<Modal>`**:
parent unmount’ит дерево мгновенно → Modal не успевает закончить fade-out.

```tsx
// БАГ: exit-анимация умирает
function MyModal({ isOpen, onClose }) {
  if (!isOpen) return null;
  return <Modal isOpen={isOpen} onClose={onClose}>...</Modal>;
}

// ПРАВИЛЬНО: пробросить isOpen, Modal сам управляет mount/unmount
function MyModal({ isOpen, onClose }) {
  return <Modal isOpen={isOpen} onClose={onClose}>...</Modal>;
}
```

Если нужно очистить зависимый state на close — `setTimeout(200, …)` в `useEffect` cleanup,
синхронно с длительностью exit-transition. JSDoc на экспорте `Modal.tsx` повторяет правило;
эталон — `gui-pro/src/components/server/UserConfigModal.tsx`. См. G-08 в CONCERNS.md.

**Связанный invariant (G-10):** `Modal.tsx` backdrop обязан содержать `backdrop-blur-sm` +
`bg-[var(--color-glass-bg)]`. Без блюра модалки читаются как тултипы; владелец проекта
дважды (2026-04-18) откатывал попытки его отключить. Если жалоба «backdrop выглядит как
disabled» — копать в содержимое модалки (loading opacity, hanging async), backdrop не трогать.

## 7. Hover/tooltip state и `tauri://blur`

Tray-click скрывает окно через `window.hide()`, но React не unmount’ит — `onMouseLeave`
не стреляет, hover-стили и tooltip остаются зафиксированными при re-show. **Любой компонент
с persistent hover/show state**, видимый при blur окна, обязан слушать `tauri://blur` и
сбрасывать state.

Эталоны:

- `gui-pro/src/components/layout/WindowControls.tsx:45` — `setHovered(null)`
- `gui-pro/src/shared/ui/Tooltip.tsx:63` — clear pending timer + `setShow(false)` (универсальный
  фикс для всех 40+ Tooltip usages)

См. G-09 в CONCERNS.md.

## 8. Рабочий процесс i18n

Всё, что видит пользователь — через `useTranslation()` из `react-i18next`. Хардкод строк в JSX запрещён.

```tsx
import { useTranslation } from "react-i18next";

function Connect() {
  const { t } = useTranslation();
  return <Button>{t("connect.start")}</Button>;
}
```

**При добавлении ключа:**

1. Добавить в `gui-pro/src/shared/i18n/locales/ru.json` (русский — приоритет).
2. Зеркалить **тот же ключ** в `en.json` с переводом.
3. Использовать `t("section.key")` в компоненте.
4. Если строка используется и в Light — зеркалить в `gui-light/src/shared/i18n/locales/*.json`.
5. **Структурная целостность JSON** — особенно при rename секций (Phase 19 «utilities» → «service»):
   Wave 0 структурный тест проверяет единственный `"service"` блок per locale. JSON duplicate
   key — известный pitfall (см. Phase 19 §Critical mitigations).

i18n инициализируется в `shared/i18n/index.ts` — язык берётся из `localStorage["tt_language"]`
или определяется по `navigator.language`.

В тестах: `i18n.changeLanguage('ru')` в `beforeEach` обязателен для компонентов с `t()`.

## 9. Worktree setup

В worktree sidecar-бинарник и DLL **отсутствуют** (gitignored). Перед первым `cargo check`
или `tauri build`:

```bash
# Из корня worktree (PowerShell или bash)
cp ../../../gui-pro/src-tauri/trusttunnel_client-x86_64-pc-windows-msvc.exe gui-pro/src-tauri/
cp ../../../gui-pro/src-tauri/wintun.dll gui-pro/src-tauri/
cp ../../../gui-pro/src-tauri/vcruntime140.dll gui-pro/src-tauri/
cp ../../../gui-pro/src-tauri/vcruntime140_1.dll gui-pro/src-tauri/

cd gui-pro
npm install
npm run build
```

Фронтенд-only фазы (i18n / stories / React-компоненты без Rust compile) могут пропустить
копирование sidecar.

`trusttunnel_client-x86_64-pc-windows-msvc.exe` объявлен в `gui-pro/src-tauri/tauri.conf.json`
как `externalBin: ["trusttunnel_client"]`. Лежит он в `gui-pro/src-tauri/`, не в `sidecar/`.
См. W-01 в CONCERNS.md.

## 10. Сборка NSIS-инсталлятора → Desktop

После значимых изменений в Pro и/или Light:

```bash
cd gui-pro
npm run tauri build -- --bundles nsis
```

Артефакт скопировать на Desktop (W-03 в CONCERNS.md). Это правило active — следует за каждым
ship-ом.

## 11. Memory documentation — обновлять при изменении UI/токенов/решений

`memory/` (gitignored) — граф знаний. Структура:

- `memory/v3/components-catalog.md` — реестр UI- и screen-компонентов.
- `memory/v3/screens/` — спецификации экранов (active: `control-panel-overview.md`,
  `control-panel-service.md`, `onboarding.md`, `update-flow.md`).
- `memory/security-posture.md` — threat model + invariants.
- `memory/project_phase{14.1,17.1,18}_*.md` — фазовые ретроспективы.

**Правило**: при изменении UI / токенов / поведения табов / архитектурного решения —
обновить соответствующий файл в `memory/v3/` (или соответствующую корневую memory-заметку)
и сохранить перекрёстные ссылки (архитектура ↔ экраны, компоненты ↔ анимации, решения
↔ реализация). См. [CLAUDE.md → Memory Documentation](CLAUDE.md#memory-documentation).

## 12. Отладка

**Frontend (DevTools):**

- В dev-режиме DevTools — F12 или ПКМ → Inspect.
- В release-билде DevTools недоступны, кроме случая, когда Cargo-фича `devtools` включена
  (см. `lib.rs` — `#[cfg(feature = "devtools")]`).

**Rust backend:**

- Логи `println!` / `eprintln!` / `tracing` идут в stdout терминала, где запущен `npm run tauri:dev`.
- Для прод-файлового логирования — `logging::log_app("INFO", "…")` → `%APPDATA%/trusttunnel/logs/`
  (если включено через флаг-файл).
- Паники Rust ломают окно Tauri — ищите `thread 'main' panicked at …` в терминале.

**VPN-события и Activity Log:**

- `vpn-status`, `vpn-log`, `internet-status` эмитятся из Rust — слушать через `useVpnEvents()`
  в компонентах.
- Activity Log включён всегда — `invoke("write_activity_log", { tag, message, details })`
  пишет запись, видимую в панели Сервис → Activity Log. **Никогда** не передавать туда
  пароли / PEM / секреты / paths (D-29 — раздел 5, шаг 6).

## 13. Phase workflow

Изменения масштаба «фаза» (см. фазы 8–19 в [CLAUDE.md → Current State](CLAUDE.md#current-state-v31-pro-v300--light-v270))
проходят через цикл планирования и исполнения, описанный в `.planning/phases/<N>-<slug>/`:

1. **Discuss** — обсуждение скоупа, researcher findings, открытые вопросы.
2. **Plan** — детализация по plan/wave с invariants (D-*), pitfalls, acceptance criteria.
3. **Execute** — выполнение по waves, каждая wave — отдельный коммит на `claude/*` ветке.
4. **Verify** — тесты, UAT по реальному VPS, проверка invariant-spy-tests.
5. **Ship** — SUMMARY.md, обновление memory docs, релизный коммит на `release/tt-win-*`.

Канонические файлы фазы: `*-PLAN.md`, `*-SUMMARY.md`, `*-UAT.md` (при наличии),
`deferred-items.md`. **При UAT-debt** (Phase 14.1 `deferred-stale`, Phase 17 partial — TD-01/TD-02 в
CONCERNS.md) SUMMARY.md перестаёт быть источником истины — читать фазовый retrospective в
`memory/project_phase*_*.md` либо commit-log.

## 14. Phase-specific подводные камни (карта)

Полная карта landmines по фазам 14–19 — в [`.planning/codebase/CONCERNS.md`](.planning/codebase/CONCERNS.md)
§5 «Phase-Specific Landmines». Структурировано по severity (HIGH/MEDIUM/LOW) с обратными
ссылками на security/gotcha-инварианты. Краткий обзор:

| Категория | Примеры | Источник в CONCERNS.md |
|-----------|---------|------------------------|
| Security invariants | char-whitelist (S-02), D-29 (S-03), SSH heredoc UUID (S-04), surgical update (S-09) | §1 |
| Process invariants | master READ-ONLY (G-01), no AI artifacts (G-02), 6-file version bump (W-02) | §2/§4 |
| Дизайн-система | inline color vs hover (G-06), Modal early-return (G-08), text-[var(--font-size-*)] (G-11) | §2 |
| Phase migrations | localStorage `tt_active_tab` "utilities" → "service" (G-15), Welcome auto-skip useMemo (G-14) | §2 |
| Tech debt | clippy baseline ~83 (TD-06), gtk-rs warnings 23 (TD-07), dead i18n keys ~15 (TD-08) | §3 |

Перед началом любой нетривиальной задачи **просмотрите соответствующий ряд таблицы фаз**
в §5 CONCERNS.md — там собраны все известные мины конкретной фазы.

## 15. Типичные подводные камни (быстрая шпаргалка)

Дублирующая ссылка на [CLAUDE.md → Gotchas](CLAUDE.md#gotchas), где этот список является
источником правды. Здесь — только самые частые:

- **`text-[var(--font-size-*)]`** генерирует `color:`, не `font-size:` — используй
  `text-xs/sm/base/lg` или семантический composite.
- **Слияние классов** — всегда через `cn()` из `shared/lib/cn.ts`.
- **Inline `style={{ color }}` побеждает hover-утилиты** — базовый цвет в className-токен,
  hover в утилитах.
- **`text-white` на цветных фонах**, не `text-[var(--color-text-inverse)]` (в dark theme — чёрный).
- **Visibility vs DOM в тестах**: cross-fade использует `visibility: hidden + opacity: 0`,
  элементы в DOM остаются. `not.toBeVisible()`, не `not.toBeInTheDocument()`.
- **Не делать `if (!isOpen) return null` перед `<Modal>`** — убивает exit-анимацию.
- **`transition-colors` не транзитит opacity** — используй `transition-opacity` или `transition-all`.
- **Hover state после `window.hide()`** — слушать `tauri://blur` и сбрасывать state.
