# Инструкция: Переработка "Настройка сервера" до уровня v2.0

## Контекст

Проект: TrustTunnel Client for Windows v2.0.0
Ветка: `release/tt-win-2.0.0`
Стек: Tauri v2 + React 19 + TypeScript + Tailwind CSS
Путь: `C:\Users\naska\Documents\TrustTunnelClient\gui-app`

Сейчас вкладка "Настройка сервера" в sidebar — это переработанный SetupWizard из v1.5 с добавленными фичами (удаление юзеров, fetch-экран, radio-select). Но это НЕ полноценная серверная панель v2.0. Нужно довести до уровня дашборда управления сервером.

## Архитектура файлов

### Текущие файлы (что есть):
- `src/components/SetupWizard.tsx` (~1600 строк) — Welcome + SSH + проверка + установка + пользователи + done/error. Это WIZARD для первичной настройки
- `src/components/ServerPanel.tsx` — Простая панель, показывается когда есть конфиг + SSH данные. Пытается подключиться и показывает статус/ошибку
- `src/App.tsx` — Логика: если `hasConfig && sshData && !forceWizard` → ServerPanel, иначе → SetupWizard

### Rust backend (команды уже созданы, но UI нет):
- `server_restart_service(host, port, user, password)` — перезагрузка сервиса TrustTunnel
- `server_stop_service(host, port, user, password)` — остановка сервиса
- `server_start_service(host, port, user, password)` — запуск сервиса
- `server_reboot(host, port, user, password)` — перезагрузка всего сервера
- `server_get_logs(host, port, user, password, lines)` — логи через journalctl
- `server_remove_user(host, port, user, password, vpnUsername)` — удаление пользователя
- `server_get_available_versions(app)` — список версий из GitHub API
- `server_upgrade(host, port, user, password, version)` — обновление/даунгрейд версии
- `check_server_installation(host, port, user, password)` — проверка: installed, version, serviceActive, users[]
- `diagnose_server(host, port, user, password)` — диагностика проблем

## Что нужно сделать

### 1. Переработать ServerPanel.tsx — превратить в полноценную панель управления

ServerPanel показывается ПОСЛЕ первичной настройки (когда есть конфиг и SSH-данные в localStorage). Это основной экран управления сервером.

**Макет ServerPanel:**
```
┌──────────────────────────────────────────────────┐
│                                                  │
│  ┌─ Статус сервера ────────────────────────────┐ │
│  │ TrustTunnel v1.0.17                         │ │
│  │ ● Сервис: работает                          │ │
│  │                                              │ │
│  │ [▶ Перезапустить]  [⏹ Остановить]  [⟳ Сервер]│ │
│  └──────────────────────────────────────────────┘ │
│                                                  │
│  ┌─ Версия ────────────────────────────────────┐ │
│  │ Текущая: v1.0.17                            │ │
│  │ Последняя: v1.0.23                          │ │
│  │ [Обновить до v1.0.23 ▾]                     │ │
│  │ (dropdown с выбором любой версии)            │ │
│  └──────────────────────────────────────────────┘ │
│                                                  │
│  ┌─ Пользователи ─────────────────────────────┐ │
│  │ sergey    [💾 Сохранить] [🗑 Удалить]       │ │
│  │ nastya    [💾 Сохранить] [🗑 Удалить]       │ │
│  │ test      [💾 Сохранить] [🗑 Удалить]       │ │
│  │                                              │ │
│  │ [+ Добавить пользователя]                    │ │
│  └──────────────────────────────────────────────┘ │
│                                                  │
│  ┌─ Логи сервера ──────────────────────────────┐ │
│  │ [Показать последние 50 строк]               │ │
│  │ (при нажатии — разворачивается блок с логами)│ │
│  └──────────────────────────────────────────────┘ │
│                                                  │
│  ┌─ Диагностика ───────────────────────────────┐ │
│  │ [Запустить диагностику]                     │ │
│  │ (при нажатии — показывает результаты)        │ │
│  └──────────────────────────────────────────────┘ │
│                                                  │
│  ┌─ Danger Zone ───────────────────────────────┐ │
│  │ [Переустановить TrustTunnel]                │ │
│  │ [Удалить TrustTunnel] (красная)             │ │
│  │ [Настроить заново] (возврат в wizard)        │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

### 2. Секция "Статус сервера"

При открытии ServerPanel — автоматически вызывать `check_server_installation`. Показывать:
- Версию TrustTunnel
- Статус сервиса (работает / остановлен / не найден)
- Кнопки управления сервисом:
  - "Перезапустить" (`server_restart_service`) — с лоадером
  - "Остановить" / "Запустить" (toggle в зависимости от статуса) — `server_stop_service` / `server_start_service`
  - "Перезагрузить сервер" (`server_reboot`) — с ConfirmDialog (это деструктивная операция!)

После каждого действия — re-check статуса.

### 3. Секция "Версия"

- Показать текущую версию (из `check_server_installation`)
- Кнопка "Проверить обновления" → вызывает `server_get_available_versions`
- Если есть новая версия — показать badge "Доступно обновление"
- Dropdown/select с выбором версии
- Кнопка "Обновить" / "Установить версию X" → вызывает `server_upgrade(version)`
- Лоадер + прогресс при обновлении
- Re-check после обновления

### 4. Секция "Пользователи"

Перенести логику из SetupWizard found-screen:
- Список пользователей с кнопками Сохранить(иконка) / Удалить(иконка)
- Radio-select для выбора активного пользователя
- "Добавить пользователя" — inline форма (имя + пароль, валидация пробелов и дубликатов)
- Кнопка "Продолжить" (disabled пока не выбран) → скачивает конфиг и переходит на Settings
- Hover на строках пользователей
- ConfirmDialog при удалении
- Блокировка параллельных удалений

### 5. Секция "Логи сервера"

- Collapsible секция (по умолчанию свёрнута)
- При развороте — вызвать `server_get_logs(lines: 50)`
- Показать логи в моноширинном шрифте
- Кнопка "Обновить логи"
- Кнопка "Копировать"
- Цветовая кодировка по уровню (error=красный, warn=жёлтый, info=серый)

### 6. Секция "Диагностика"

- Кнопка "Запустить диагностику" → `diagnose_server`
- Лоадер при выполнении
- Результаты в читаемом формате (что проверялось, статус каждой проверки)
- Подсказки по устранению проблем

### 7. Danger Zone

- "Переустановить TrustTunnel" — переход в wizard на endpoint step
- "Удалить TrustTunnel" — ConfirmDialog → `uninstall_server` → возврат в wizard welcome
- "Настроить заново" — возврат в wizard welcome (forceWizard)

Красный стиль для "Удалить", обычный для остальных.

## Дизайн-правила

### Стилистика (CSS Variables)
Все компоненты ДОЛЖНЫ использовать CSS Variables, НЕ хардкод Tailwind-классы:
- `var(--color-bg-primary)` — основной фон
- `var(--color-bg-surface)` — фон карточек
- `var(--color-bg-elevated)` — приподнятый фон (модалы)
- `var(--color-bg-hover)` — hover
- `var(--color-text-primary)` — основной текст
- `var(--color-text-secondary)` — вторичный
- `var(--color-text-muted)` — приглушённый
- `var(--color-border)` — границы
- `var(--color-accent-500)` — акцент (кнопки)
- `var(--color-success-500)` — успех
- `var(--color-warning-500)` — предупреждение
- `var(--color-danger-500)` — ошибка/опасность

### Кнопки — три уровня:
1. **Primary** (accent) — `backgroundColor: var(--color-accent-500), color: white`
2. **Secondary** (с border) — `backgroundColor: var(--color-bg-hover), border: 1px solid var(--color-border), color: var(--color-text-secondary)` + `hover:opacity-80`
3. **Ghost** (только текст) — `color: var(--color-text-secondary)` + hover bg fill (`onMouseEnter/Leave`)
4. **Danger** — `backgroundColor: rgba(239,68,68,0.08), border: 1px solid rgba(239,68,68,0.25), color: var(--color-danger-500)`

### ConfirmDialog
- Рендерить через `createPortal(... , document.body)`
- `position: fixed, top: -50px, left: -50px, right: -50px, bottom: -50px` — чтобы захватить titlebar
- Кнопки disabled во время операции, лоадер на кнопке подтверждения
- Закрывать диалог СРАЗУ после confirm, показывать лоадер в основном UI

### Hover эффекты
- Ghost кнопки ("Назад", "Отмена", "На главную") — `onMouseEnter → bg = var(--color-bg-hover)`, `onMouseLeave → bg = transparent`
- Строки списков (пользователи) — аналогичный hover
- Secondary кнопки — `hover:opacity-80`

### Tooltip/подсказки
- Для каждой секции и важной кнопки — добавить `title` атрибут с пояснением
- В будущем заменить на кастомный Tooltip компонент

## Порядок работы

1. Прочитать текущий `ServerPanel.tsx` полностью
2. Прочитать `SetupWizard.tsx` — понять какие части можно переиспользовать
3. Переписать `ServerPanel.tsx` с нуля по макету выше
4. Убедиться что все Rust-команды вызываются корректно (проверить сигнатуры в `lib.rs`)
5. Проверить TypeScript (`npx tsc --noEmit`)
6. Собрать (`npx tauri build`)
7. Упаковать zip на рабочий стол (`C:\Users\naska\Desktop\TrustTunnel-v2.0-portable.zip`)

## SSH-данные

SSH-данные (host, port, user, password) хранятся в `localStorage` под ключом `trusttunnel_wizard`:
```js
const raw = localStorage.getItem("trusttunnel_wizard");
const obj = JSON.parse(raw);
// obj.host, obj.port, obj.sshUser, obj.sshPassword (base64 obfuscated: "b64:...")
```

В `App.tsx` они извлекаются в `sshData` и передаются как props в ServerPanel.

## Важные нюансы

1. **Пароль SSH обфусцирован** — хранится как `"b64:..."` в localStorage, нужно деобфусцировать через `deobfuscate()` функцию
2. **Темы** — ВСЁ должно корректно выглядеть и в dark, и в light теме. Проверять оба варианта
3. **i18n** — новые строки добавлять в `src/shared/i18n/locales/ru.json` и `en.json`
4. **Билд** — после каждого изменения: `cd gui-app && rm -rf dist && npx tauri build`. Zip только на рабочий стол, никаких папок
5. **Не ломать SetupWizard** — wizard продолжает работать для первичной настройки. ServerPanel — это POST-setup экран
6. **Scrollable** — ServerPanel может быть длинной, контент должен скроллиться
