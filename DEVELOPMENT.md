<!-- generated-by: gsd-doc-writer -->
# Development

Этот документ описывает повседневные рабочие процессы разработки: структуру репозитория,
dev-циклы для фронтенда и бэкенда, Storybook, i18n, добавление IPC-команд, отладку
и типичные подводные камни.

Первый запуск и установка зависимостей описаны в [GETTING-STARTED.md](GETTING-STARTED.md).
Общая архитектура — в [ARCHITECTURE.md](ARCHITECTURE.md). Правила код-стиля и дизайн-системы
консолидированы в [CLAUDE.md](CLAUDE.md) (разделы Design System Rules, Critical Rules, Gotchas).

## 1. Структура репозитория

Монорепозиторий с двумя Tauri-приложениями и общим C++-ядром:

```
TrustTunnelClient/
├── gui-pro/              # Pro-редакция (React + Rust + SSH)
│   ├── src/              # Frontend (React 19 + TS)
│   ├── src-tauri/        # Rust backend + Tauri config
│   └── .storybook/       # Storybook + Tauri mocks
├── gui-light/            # Light-редакция (упрощённый клиент)
│   ├── src/
│   └── src-tauri/
├── trusttunnel/          # C++ sidecar (исходники)
├── core/  net/  platform/ tcpip/ common/   # C++ библиотеки TrustTunnel
├── third-party/          # Внешние C++ зависимости
├── cmake/ CMakeLists.txt # Сборка C++ sidecar
├── integration-tests/    # Системные тесты
├── installer/            # NSIS-артефакты
├── scripts/              # Вспомогательные скрипты
├── .planning/            # Внутренние планы фаз (gitignored местами)
└── memory/               # Документация дизайн-системы (gitignored)
```

Pro и Light — два отдельных npm-пакета с собственными `package.json` и `src-tauri/`.
Общего `package.json` в корне нет — каждую редакцию разрабатываем из её директории.

## 2. Frontend dev-loop

Два режима запуска фронтенда — выбор зависит от того, нужен ли Rust-бэкенд.

```bash
# Из gui-pro/ (или gui-light/)
npm run dev          # Vite dev-сервер на http://127.0.0.1:1420 (браузер, без Tauri)
npm run tauri:dev    # Полноценное окно Tauri с Rust-бэкендом и hot-reload
```

**Когда использовать `npm run dev`:**

- Чистая работа над UI: разметка, стили, анимации, CVA-варианты.
- Все `invoke("…")`-вызовы в браузере вернут ошибку — это нормально, мокать не требуется,
  если экран не зависит от данных от Rust.
- Самый быстрый цикл: Vite перезагружает страницу за ~200 мс.

**Когда использовать `npm run tauri:dev`:**

- Нужен реальный ответ от Rust-команд (SSH, VPN, конфиги, сеть).
- Проверяете системные интеграции: трей, deep-link `tt://`, автозапуск, окно.
- Frontend hot-reload работает, Rust — пересобирается автоматически при изменении `.rs`
  (но долго — см. раздел 3).

## 3. Backend dev-loop (Rust)

Rust-код живёт в `gui-pro/src-tauri/src/`. Изменения триггерят пересборку `cargo build`
внутри `tauri dev`.

```bash
# Из gui-pro/src-tauri/
cargo check             # Быстрая проверка типов без линковки (~5-15 с)
cargo clippy -D warnings # Линтер (то же, что npm run rust:check)
cargo fmt --check       # Форматирование
```

**Практические советы:**

- `cargo check` быстрее, чем ждать перезапуск `tauri dev` — используйте его для итераций
  по Rust-коду, пока не будете готовы проверить IPC целиком.
- Изменения в `commands/*.rs` требуют полного перезапуска `npm run tauri:dev` — просто
  сохранение файла приведёт к пересборке, но обновление handler-таблицы требует
  нового запуска окна.
- Первая сборка долгая (~5 минут на холодном cache). Последующие — 30-60 секунд.
- В worktree перед первым `cargo check` скопируйте `sidecar/` и DLL — см. CLAUDE.md →
  Worktree Setup.

## 4. Storybook

Изолированная среда для разработки UI-компонентов с мок-данными вместо Tauri IPC.

```bash
npm run storybook        # Dev-сервер на http://localhost:6006
npm run build-storybook  # Статический билд для деплоя
```

В проекте **42 story-файла** (~270 stories), покрывающих `shared/ui/*`, `components/layout/*`
и ключевые панели (ControlPanelPage, ServerPanel, ServerTabs, ServerSidebar).

**Tauri mocks** живут в `.storybook/tauri-mocks/` — шесть файлов:

- `api-core.ts` — мок `invoke()`
- `api-event.ts` — мок `emit()/listen()`
- `api-app.ts`, `api-window.ts` — стабы Tauri окна
- `plugin-dialog.ts`, `plugin-shell.ts` — плагины

Vite-алиасы в `.storybook/main.ts` подменяют реальные импорты на моки, так что
`invoke("…")` в компонентах возвращает детерминированные данные из стори.

**Правило проекта:** новые компоненты в `shared/ui/` и нетривиальные панели в `components/`
**обязаны** иметь `.stories.tsx`. Интерактивные stories используют `useState` внутри `render()`.

## 5. Рабочий процесс i18n

Всё, что видит пользователь — через `useTranslation()` из `react-i18next`. Хардкод
строк в JSX запрещён.

```tsx
import { useTranslation } from "react-i18next";

function Connect() {
  const { t } = useTranslation();
  return <Button>{t("connect.start")}</Button>;
}
```

**При добавлении нового ключа:**

1. Добавьте ключ в `gui-pro/src/shared/i18n/locales/ru.json` (приоритет — русский).
2. Добавьте **тот же ключ** в `en.json` с английским переводом.
3. Используйте `t("section.key")` в компоненте.
4. Для Light — зеркальте в `gui-light/src/shared/i18n/locales/*.json`, если строка там используется.

i18n инициализируется в `shared/i18n/index.ts` — язык берётся из `localStorage["tt_language"]`
или определяется по `navigator.language`.

В тестах обязательно: `i18n.changeLanguage('ru')` в `beforeEach` для компонентов с `t()`.

## 6. Добавление IPC-команды

Frontend вызывает Rust через `invoke("name", { params })`. Типичный цикл:

**Шаг 1. Определите команду в Rust:**

```rust
// gui-pro/src-tauri/src/commands/network.rs
#[tauri::command]
pub async fn health_check(host: String, port: u16) -> serde_json::Value {
    // ... логика
    serde_json::json!({ "ok": true, "latency_ms": 42 })
}
```

**Шаг 2. Зарегистрируйте команду в `lib.rs`:**

```rust
// gui-pro/src-tauri/src/lib.rs
.invoke_handler(tauri::generate_handler![
    // ... существующие команды
    commands::network::health_check,
])
```

**Шаг 3. Определите TS-интерфейс, зеркальный Rust-структуре:**

```ts
// где-то рядом с вызывающим кодом
interface HealthCheckResult {
  ok: boolean;
  latency_ms: number;
}
```

**Шаг 4. Вызовите из фронтенда:**

```ts
import { invoke } from "@tauri-apps/api/core";

const result = await invoke<HealthCheckResult>("health_check", {
  host: "example.com",
  port: 443,
});
```

Имена параметров в `invoke(...)` — **snake_case**, как в Rust-сигнатуре. Tauri
автоматически конвертирует в camelCase на TS-стороне только для возвращаемых значений,
если структура помечена `#[serde(rename_all = "camelCase")]`.

**Обратный канал (Rust → Frontend) — события:**

```rust
app.emit("vpn-status", VpnStatusPayload { status: "connected".into(), error: None })?;
```

```ts
import { listen } from "@tauri-apps/api/event";
const unlisten = await listen<VpnStatusPayload>("vpn-status", (e) => {
  console.log(e.payload);
});
```

После добавления команды перезапустите `npm run tauri:dev` — handler-таблица
регистрируется при старте.

## 7. Отладка

**Frontend (DevTools):**

- В dev-режиме DevTools открываются через F12 или ПКМ → Inspect.
- В release-билде DevTools недоступны, кроме случая, когда Cargo-фича `devtools`
  включена (см. `lib.rs` — `#[cfg(feature = "devtools")]`).

**Rust backend:**

- Логи `println!` / `eprintln!` / `tracing` идут в stdout терминала, где запущен
  `npm run tauri:dev`.
- Для прод-файлового логирования используется `logging::log_app("INFO", "…")` —
  пишется в `%APPDATA%/trusttunnel/logs/` (если включено через флаг-файл).
- Паники Rust ломают окно Tauri — ищите в терминале `thread 'main' panicked at …`.

**VPN-события и Activity Log:**

- `vpn-status`, `vpn-log`, `internet-status` эмитятся из Rust — слушайте через
  `useVpnEvents()` в компонентах.
- Activity Log включён всегда — `invoke("write_activity_log", { tag, message, details })`
  пишет запись, видимую в панели Сервис → Activity Log.

## 8. Типичные подводные камни

Самое важное — см. также CLAUDE.md → Design System Rules и Gotchas.

- **`text-[var(--font-size-*)]`**: Tailwind генерирует для этой записи `color:`, а не
  `font-size:`. Используйте `text-xs/sm/base/lg` (маппинг в `tailwind.config.js`).
- **Слияние классов**: всегда через `cn()` из `shared/lib/cn.ts`. Она расширяет
  `tailwind-merge` кастомной группой `font-size`, чтобы конфликт размеров разрешался
  корректно.
- **Inline `style={{ color: ... }}` перебивает hover-утилиты**: если задать цвет
  инлайн-стилем, Tailwind-классы типа `hover:text-accent` работать не будут. Управляйте
  цветом через классы и CSS-токены.
- **`text-white` на цветных фонах**: `--color-text-inverse` в тёмной теме — чёрный,
  поэтому для кнопок с заливкой (primary/danger) всегда `text-white`.
- **Visibility vs DOM в тестах**: cross-fade табов использует `visibility: hidden + opacity: 0`,
  элементы остаются в DOM. Проверяйте `not.toBeVisible()`, а не `not.toBeInTheDocument()`.
