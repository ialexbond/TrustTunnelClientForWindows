# Phase 1: Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-13
**Phase:** 01-infrastructure-release-setup
**Areas discussed:** Цветовая палитра, Глубина токенов, Storybook Foundations, Glow и эффекты

**User preamble:** "Нужен абсолютно новый подход к созданию дизайн-системы. Дизайн не должен копировать предыдущую версию. Новые принципы, новая концепция, новые цвета, акценты и подход."

---

## Цветовая палитра

### Настроение палитры

| Option | Description | Selected |
|--------|-------------|----------|
| Тёплый премиум | Золотисто-медные акценты, глубокий тёмный фон. Arc Browser, 1Password | |
| Холодный техно | Бирюзово-голубые акценты, чистые линии. Cloudflare WARP, NordVPN | |
| Яркий современный | Энергичные градиенты, вибрантные акценты. Discord, Figma | |
| Сдержанная элегантность | Приглушённые тона, минимальный цвет. Linear, Raycast, Apple | ✓ |

**User's choice:** Сдержанная элегантность, но уточнил — минимализм, приглушённые оттенки, контрастные и монохромные. "Всё должно быть максимально просто по цветам и сдержанно."

### Характер тёмной темы

| Option | Description | Selected |
|--------|-------------|----------|
| Чисто чёрный | OLED-black (#000-#0a). Максимальный контраст | |
| Тёплый графит | Тёмно-серый с тёплым подтоном (#1a1a1e). Мягче для глаз | ✓ (custom) |
| Холодный slate | Тёмно-синий/слейт (#0f172a). Как сейчас, но глубже | |
| Ты решаешь | Claude подберёт | |

**User's choice:** "Дорогой, тёмный, серый или ближе к чёрному фон. Чуть больше цветового контраста. Не синеватый как сейчас."

### Акцентный цвет

| Option | Description | Selected |
|--------|-------------|----------|
| Приглушённый blue | Тихий синий (#3b82f6). Linear, Raycast | |
| Нейтральный серый | Почти без акцента. Apple System Prefs | |
| Тёплый amber | Мягкий янтарный. 1Password стиль | |
| Ты решаешь | Claude подберёт | ✓ |

**User's choice:** "Black and white система. Акцент на усмотрение Claude, главное — не повторять indigo из v2. Нужны status colors: зелёный (успех), красный (неудача), жёлтый/синий (предупреждения)."

### Светлая тема

| Option | Description | Selected |
|--------|-------------|----------|
| Чистый белый | #ffffff фон. Apple, Notion | |
| Тёплый кремовый | Слегка тёплый (#fafaf8). Мягче для глаз | ✓ |
| Прохладный серый | Светло-серый (#f4f4f5). Linear light, GitHub | |
| Ты решаешь | Claude подберёт | |

**User's choice:** "Тёплый кремовый. Должна мэтчиться с тёмной по контрасту — все тексты, шрифты, кнопки читаются при быстром переключении."

---

## Глубина токенов

| Option | Description | Selected |
|--------|-------------|----------|
| Компактные шкалы | 6 spacing, 4 typography. Просто, консистентно | |
| Стандартные шкалы | 10 spacing, 6 typography. Как Tailwind | |
| Ты решаешь | Claude подберёт под 32 компонента | ✓ |

**User's choice:** "Ты решаешь"

---

## Storybook Foundations

| Option | Description | Selected |
|--------|-------------|----------|
| Минимум для работы | Простые таблицы токенов с превью | |
| Showcase quality | Интерактивные палитры, do/don't, guidelines | |
| Ты решаешь | Claude выберет под solo dev | |

**User's choice:** Полноценная палитра. Все компоненты, связанные с текущим экраном, видны в Storybook.
**Notes:** Пользователь незнаком со Storybook, хочет визуально тестировать. Уточнено: Phase 1 = инфраструктура + Foundations MDX, компоненты экранов — Phase 2+.

---

## Glow и эффекты

| Option | Description | Selected |
|--------|-------------|----------|
| Минимальные эффекты | Убрать glow, оставить тени. Linear/Raycast стиль | ✓ |
| Тонкие glow | Glow только для VPN-статуса, убрать остальное | |
| Переосмыслить | Новая система эффектов с нуля | |
| Ты решаешь | Claude выберет под сдержанную элегантность | |

**User's choice:** "Минимальные эффекты"

---

## Claude's Discretion

- Token scale granularity (spacing, typography, shadows)
- Specific accent color (not indigo, professional, pleasant)
- Storybook MDX page depth

## Deferred Ideas

- Все компоненты Control Panel в Storybook — Phase 2-3
- "Настройки VPN" (Server Panel) — Phase 4 per roadmap
