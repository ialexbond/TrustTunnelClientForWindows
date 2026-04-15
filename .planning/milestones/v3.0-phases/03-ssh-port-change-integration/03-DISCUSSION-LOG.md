# Phase 3: Control Panel - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-14
**Phase:** 03-control-panel
**Areas discussed:** Границы редизайна, StatusPanel → StatusBadge, Визуальная структура, Storybook и документация

---

## Границы редизайна

| Option | Description | Selected |
|--------|-------------|----------|
| Включить в Phase 3 (рекомендуется) | SshConnectForm — первое что видит пользователь. Мигрировать на FormField + токены сейчас — proof-of-concept будет полным | |
| Только обёртку + хедер | Мигрировать только ControlPanelPage (layout, header, Button отключения). SshConnectForm откладываем в Phase 4 вместе с ServerPanel | |

**User's choice:** SshConnectForm включить в Phase 3. Пользователь также предложил добавить мульти-серверность (хранение нескольких серверов, переключение без повторного ввода кредов).
**Notes:** Мульти-серверность определена как scope creep (новая функциональность = backend + UI + хранилище). Отложена в backlog по согласованию с пользователем.

### Подвопрос: мульти-серверность

| Option | Description | Selected |
|--------|-------------|----------|
| Отложить (рекомендуется) | Записать в backlog. Phase 3 = визуальная миграция, мульти-сервер = новый milestone/фаза | ✓ |
| Включить сюда | Добавить мульти-сервер в Phase 3 (расширяет скоуп значительно: backend + UI + хранилище) | |

**User's choice:** Отложить (рекомендуется)

---

## StatusPanel → StatusBadge

### Формат StatusPanel

| Option | Description | Selected |
|--------|-------------|----------|
| Сохранить strip-формат (рек.) | Компактная полоса: StatusBadge + uptime + кнопка действия. Замена legacy Badge на StatusBadge, остальное на токены | |
| Расширенный блок | Более выразительный блок с иконкой состояния, текстом статуса, IP/подробностями соединения, кнопкой | |
| Ты решай | Claude выберет оптимальную структуру в рамках сдержанной элегантности | ✓ |

**User's choice:** Claude's discretion

### Отображение ошибок

| Option | Description | Selected |
|--------|-------------|----------|
| ErrorBanner под StatusPanel | Существующий ErrorBanner (CVA severity) под статус-полосой — унифицировано с остальными экранами | |
| Inline в StatusPanel | Ошибка внутри стрипа (как сейчас), но с token-стилями | |
| Ты решай | Claude выберет лучший подход к отображению ошибок | |

**User's choice:** Freeform — хочет SnackBar для коротких + что-то для длинных. Никакого inline. Должно быть стильно и в тему.

### Уточнение: комбо-подход

| Option | Description | Selected |
|--------|-------------|----------|
| SnackBar + ErrorBanner (рек.) | Короткие ошибки/success → SnackBar (auto-dismiss). Длинные/критичные → ErrorBanner (dismiss вручную, expandable для полного текста) | ✓ |
| Только SnackBar | Все уведомления через SnackBar. Длинные тексты обрезать + кнопка «подробнее» | |

**User's choice:** SnackBar + ErrorBanner (рекомендуется)

---

## Визуальная структура

### SshConnectForm layout

| Option | Description | Selected |
|--------|-------------|----------|
| Компактная карточка (рек.) | Card по центру экрана, FormField для полей, кнопка внизу. Как login-экран в Linear/Raycast | |
| Во весь экран | Форма занимает всю панель (как сейчас), но с новыми компонентами | |
| Ты решай | Claude выберет оптимальный лейаут в стиле Linear/Raycast | ✓ |

**User's choice:** Claude's discretion

### Header redesign

| Option | Description | Selected |
|--------|-------------|----------|
| Редизайнить (рек.) | Header на токенах: bg, border, spacing из tokens.css. Кнопка отключения новым Button(ghost) | |
| Минимально | Только замена hardcoded стилей на токены, без визуальных изменений | |

**User's choice:** "Нужен полноценный редизайн, полноценный. Все нужно изменить, все что можно поменять, чтобы это выглядело по-новому и свежо." → Полный редизайн.

---

## Storybook и документация

### Stories strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Компоненты отдельно (рек.) | Stories для StatusPanel (все 6 VPN-состояний) + SshConnectForm (пустая, заполненная, ошибка, loading). Не пытаться мокать всю страницу целиком | |
| Полная страница | Story для ControlPanelPage целиком. Мокать все Tauri invoke — сложно, но показывает экран как есть | |
| Ты решай | Claude выберет оптимальную стратегию stories | ✓ |

**User's choice:** Claude's discretion

### Поведенческая спека

| Option | Description | Selected |
|--------|-------------|----------|
| Полная спека (рек.) | Все состояния, переходы, крайние случаи, ссылки на компоненты. Это первый экран — задаёт шаблон для Phase 4 | ✓ |
| Краткая спека | Основные состояния и переходы без крайних случаев | |

**User's choice:** Полная спека (рекомендуется)

---

## Claude's Discretion

- StatusPanel формат (strip vs expanded)
- SshConnectForm layout (Card vs full-screen vs other)
- Storybook stories strategy (component-level vs page-level)

## Deferred Ideas

- **Мульти-серверность** — хранение нескольких серверов, переключение без повторного ввода кредов, чекбокс "сохранить данные" → отдельная фаза/milestone
