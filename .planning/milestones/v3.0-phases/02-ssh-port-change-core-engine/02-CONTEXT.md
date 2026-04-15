# Phase 2: Primitive Redesign - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 полностью переделывает все UI примитивы в `shared/ui/`. Каждый компонент переписывается с нуля на CVA + токены. Добавляются 7 новых компонентов. Все покрываются Storybook stories с полным state coverage. Документация в memory/v3/.

Скоуп:
- 19 существующих компонентов → полный редизайн (новый API допускается)
- 7 новых компонентов: Section, FormField, StatusBadge, EmptyState, Separator, ProgressBar, Select
- Storybook stories для каждого компонента
- memory/v3/design-system/ документация

</domain>

<decisions>
## Implementation Decisions

### Стратегия миграции
- **D-01:** Полный редизайн с нуля — НЕ инкрементальная замена цветов. Каждый компонент переписывается заново с современным подходом
- **D-02:** Внешний API (props) МОЖНО менять — потребители обновляются в рамках этой же фазы
- **D-03:** Стандарт: нормы дизайна 2026 года. Чисто, систематизировано, проверяемо, работоспособно

### CVA и стилизация
- **D-04:** CVA (class-variance-authority) + Tailwind — стандартный подход shadcn/ui, Linear, Vercel
- **D-05:** Все цвета только через CSS-переменные из tokens.css (zero hardcoded hex)
- **D-06:** Варианты Button: primary, danger, ghost, icon. Размеры: sm, md, lg
- **D-07:** Варианты Badge: success, warning, danger, neutral, dot
- **D-08:** Варианты ErrorBanner: по severity

### Новые компоненты
- **D-09:** Все 7 компонентов равноважны, делаются в одной фазе
- **D-10:** Select/Dropdown — кастомный, заменяет нативный <select>. Используется в настройках и SSH конфигах
- **D-11:** StatusBadge — статус VPN подключения (connected/connecting/error/disconnected). ProgressBar — прогресс операций
- **D-12:** FormField — label + input + error message wrapper. Section — группировка контента с заголовком
- **D-13:** EmptyState — placeholder для пустых списков/состояний
- **D-14:** Separator — визуальный разделитель (horizontal/vertical)
- **D-15:** Стиль и поведение — ориентация на shadcn/ui, адаптированный для VPN десктоп-приложения

### Storybook stories
- **D-16:** Полное покрытие: каждый компонент → все варианты, все размеры, все состояния (default, hover, focus, active, disabled, error)
- **D-17:** Обе темы обязательны — каждая story проверяется в dark и light
- **D-18:** Stories — основной инструмент приёмки. Пользователь тестирует/одобряет компоненты через Storybook

### Оценка качества
- **D-19:** После завершения Phase 2 — обязательно запустить скиллы оценки дизайн-системы (UI review, design system audit) для проверки качества

### Claude's Discretion
- Конкретный дизайн и внутренняя архитектура каждого компонента
- Naming convention для CVA вариантов (camelCase vs kebab-case)
- Порядок реализации компонентов (волны/зависимости)
- Конкретные размеры, отступы, радиусы — в рамках токен-системы Phase 1
- Реализация hover/focus/active состояний

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design System Foundation (Phase 1 output)
- `gui-app/src/shared/styles/tokens.css` — Полная двухуровневая токен-система (262 строки): primitives + dark/light semantics
- `gui-app/src/shared/styles/fonts/` — Geist Sans + Geist Mono (variable woff2)
- `gui-app/src/index.css` — Глобальные стили, анимации, скроллбары
- `gui-app/.storybook/main.ts` — Storybook конфигурация с Tauri mocks и addon-docs
- `gui-app/.storybook/preview.ts` — Theme toggle, CSS загрузка

### Design Philosophy
- `memory/decisions/v3-philosophy.md` — Contract-first development process
- `memory/decisions/v3-design-guidelines.md` — Visual direction, anti-patterns
- `memory/v3/design-system/tokens.md` — Token architecture rules (5 правил)
- `memory/v3/decisions/phase-1-decisions.md` — 9 решений Phase 1 (palette, font, weights)

### Existing Components (current state to transform FROM)
- `gui-app/src/shared/ui/` — 19 существующих компонентов (полный список в index.ts)
- `gui-app/src/shared/ui/colors.ts` — Deprecated glow values (to be removed in Phase 2+)

### Phase 1 Context (locked decisions that carry forward)
- `.planning/phases/01-infrastructure-release-setup/01-CONTEXT.md` — D-01 to D-13 visual direction decisions

</canonical_refs>

<specifics>
## Specific Ideas

- shadcn/ui как референс стиля и API дизайна
- CVA compound variants для сложных комбинаций (variant + size + state)
- Все компоненты должны быть forwardRef-совместимы
- Geist Sans как основной шрифт (установлен в Phase 1)
- Slate-teal accent (#4d9490 dark / #236260 light) — только для интерактивных элементов

</specifics>

<deferred>
## Deferred Ideas

- Полное удаление colors.ts (Phase 2 депрекирует, но может удалить если все потребители мигрированы)
- Компоненты высшего уровня (layouts, compositions) — Phase 3+
- Анимации переходов между состояниями — рассмотреть в Phase 3

</deferred>

---

*Phase: 02-primitive-redesign*
*Context gathered: 2026-04-13 via interactive discussion*
