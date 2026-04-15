# Phase 4: Application Shell - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-14
**Phase:** 04-application-shell
**Areas discussed:** Модель навигации, WindowControls, Бесшовность UI, ServerSidebar

---

## Scope Restructuring (Pre-discussion)

| Option | Description | Selected |
|--------|-------------|----------|
| Разбить на экраны | Каждый экран — отдельная фаза | |
| Выбрать первый экран | Обсудить контекст только для первого экрана | |
| Сначала решить порядок | Обсудить порядок экранов, потом разбивку фаз | ✓ |

**User's choice:** Сначала решить порядок
**Notes:** Пользователь считает Phase 4 слишком большой (7 экранов + 13 секций). Хочет идти "от общего к частному": сначала окно и навигация, потом экраны по одному.

---

## Первый экран

| Option | Description | Selected |
|--------|-------------|----------|
| ServerPanel (рек.) | Самый сложный, продолжение Phase 3 | |
| SetupWizard | Первое что видит пользователь, маленький | |
| SettingsPanel | Маленький, Section/Toggle компоненты | |
| RoutingPanel | Сложный UI с GeoIP/GeoSite | |

**User's choice:** Кастомное окно Windows + навигация/меню
**Notes:** Пользователь хочет начать с общей оболочки: кастомное окно, переосмыслить навигацию (конфликт двух sidebar-ов), добавить бесшовность и минимализм. Phase 4 переопределена как "Application Shell".

---

## Модель навигации

### Тип навигации

| Option | Description | Selected |
|--------|-------------|----------|
| Компактный sidebar (рек.) | Постоянный узкий sidebar ~48px, tooltip при наведении | |
| Tabs сверху | Горизонтальные табы, как в v1 | ✓ |
| Hover-sidebar (current) | Оставить текущий sidebar с hover-раскрытием | |

**User's choice:** Tabs сверху
**Notes:** Сложный выбор. Хочет логотип/название видимым. Табы на всю ширину окна сверху.

### Размещение табов

| Option | Description | Selected |
|--------|-------------|----------|
| В title bar (рек.) | Табы + WindowControls в одном ряду | |
| Под title bar | Табы отдельной полосой | |
| На усмотрение | Claude решит | ✓ |

**User's choice:** На усмотрение Claude (best practices)

### Dashboard

| Option | Description | Selected |
|--------|-------------|----------|
| Убрать | Статистика не критична | |
| Оставить | Полезно для Pro | |
| Слить в StatusPanel | Расширить StatusPanel статистикой | |

**User's choice:** Расформировать — серверная часть в панель управления, клиентская в подключение

### Два "настройки"

| Option | Description | Selected |
|--------|-------------|----------|
| Объединить (рек.) | Один таб с секциями | |
| Оставить отдельно | Как сейчас | ✓ (с переименованием) |

**User's choice:** Оставить раздельно. "Настройки VPN" → "Подключение", "Настройки приложения" → "Настройки"

### Набор табов

| Option | Description | Selected |
|--------|-------------|----------|
| 7 табов | Все текущие минус Dashboard | |
| 5 табов | Панель управления, Подключение, Маршрутизация, Настройки, О программе | ✓ |

**User's choice:** 5 табов

### Название таба 2

| Option | Description | Selected |
|--------|-------------|----------|
| VPN | Короткое | |
| Подключение | Точнее, отражает конфиг + соединение | ✓ |
| Сервер | Серверный конфиг | |

**User's choice:** Подключение

---

## WindowControls

### Содержание title bar

| Option | Description | Selected |
|--------|-------------|----------|
| Лого + название | Лого TrustTunnel слева, кнопки справа | ✓ |
| Только кнопки | Минимализм, пустая drag area | |
| Лого + статус VPN | Лого + индикатор VPN, кнопки справа | |

**User's choice:** Название программы (TrustTunnel Pro/Lite) + кнопки min/max/close. Hover-эффекты по дизайн-системе.

### Визуальное отделение

| Option | Description | Selected |
|--------|-------------|----------|
| Бесшовный (рек.) | Тот же фон, без бордера | ✓ |
| С разделителем | Тонкая линия или тень | |
| На усмотрение | Claude решит | |

**User's choice:** Бесшовный
**Notes:** Единый фон (кремовый/тёмный), блоки различаются оттенками.

---

## Бесшовность UI

### Разделение блоков

| Option | Description | Selected |
|--------|-------------|----------|
| Отступы + оттенки | Spacing + лёгкие отличия в фоне | |
| Минимум бордеров | Бордеры только где необходимо | |
| На усмотрение | Claude подберёт баланс | ✓ |

**User's choice:** На усмотрение Claude
**Notes:** "Один общий фон, оттенками различать блоки. Бесшовное приложение."

---

## ServerSidebar

### Судьба ServerSidebar

| Option | Description | Selected |
|--------|-------------|----------|
| Убрать пока | Вернуть при мульти-сервере | |
| Оставить и редизайнить | Переоформить по дизайн-системе | ✓ |
| Перенести в таб | Инфо о сервере внутри таба | |

**User's choice:** Оставить и редизайнить

### Размещение

| Option | Description | Selected |
|--------|-------------|----------|
| Слева как сейчас | Узкая панель от контента | |
| На усмотрение | Claude подберёт | ✓ |

**User's choice:** На усмотрение Claude

---

## Claude's Discretion

- Tab placement relative to WindowControls
- Visual separation strategy (spacing vs shades vs minimal borders)
- ServerSidebar placement in new layout
- Logo placement
- English i18n keys for tab names

## Deferred Ideas

- Multi-server functionality → separate milestone
- Individual screen redesigns → separate phases
- Setup Wizard redesign → separate phase
- Component naming audit → during or after shell redesign
