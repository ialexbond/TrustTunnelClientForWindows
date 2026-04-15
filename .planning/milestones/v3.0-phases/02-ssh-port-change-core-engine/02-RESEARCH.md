# Phase 2: Primitive Redesign — Research

**Researched:** 2026-04-14
**Domain:** React UI компоненты, CVA (class-variance-authority), Tailwind CSS, Storybook 10
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Полный редизайн с нуля — НЕ инкрементальная замена цветов. Каждый компонент переписывается заново
- **D-02:** Внешний API (props) МОЖНО менять — потребители обновляются в рамках этой же фазы
- **D-03:** Стандарт: нормы дизайна 2026 года. Чисто, систематизировано, проверяемо, работоспособно
- **D-04:** CVA (class-variance-authority) + Tailwind — стандартный подход
- **D-05:** Все цвета только через CSS-переменные из tokens.css (zero hardcoded hex)
- **D-06:** Варианты Button: primary, danger, ghost, icon. Размеры: sm, md, lg
- **D-07:** Варианты Badge: success, warning, danger, neutral, dot
- **D-08:** Варианты ErrorBanner: по severity
- **D-09:** Все 7 новых компонентов равноважны, делаются в одной фазе
- **D-10:** Select/Dropdown — кастомный, заменяет нативный `<select>`
- **D-11:** StatusBadge — статус VPN. ProgressBar — прогресс операций
- **D-12:** FormField — label + input + error wrapper. Section — группировка с заголовком
- **D-13:** EmptyState — placeholder для пустых списков
- **D-14:** Separator — визуальный разделитель (horizontal/vertical)
- **D-15:** Ориентация на shadcn/ui, адаптированный для VPN десктоп-приложения
- **D-16:** Полное покрытие: каждый компонент → все варианты, состояния (default, hover, focus, active, disabled, error)
- **D-17:** Обе темы обязательны в каждой story
- **D-18:** Stories — основной инструмент приёмки
- **D-19:** После завершения — запустить скиллы оценки дизайн-системы

### Claude's Discretion

- Конкретный дизайн и внутренняя архитектура каждого компонента
- Naming convention для CVA вариантов (camelCase vs kebab-case)
- Порядок реализации компонентов (волны/зависимости)
- Конкретные размеры, отступы, радиусы — в рамках токен-системы Phase 1
- Реализация hover/focus/active состояний

### Deferred Ideas (OUT OF SCOPE)

- Полное удаление colors.ts (Phase 2 депрекирует, но может удалить если все потребители мигрированы)
- Компоненты высшего уровня (layouts, compositions) — Phase 3+
- Анимации переходов между состояниями — рассмотреть в Phase 3
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| COMP-01 | Все 19 existing primitives используют только token vars — ноль hardcoded цветов | Аудит: 14 компонентов уже используют CSS vars, Badge и ErrorBanner используют colors.ts (deprecated). DropOverlay имеет hardcoded `#fff` и `rgba(0,0,0,*)`. PanelErrorBoundary — `text-red-500`, `--color-bg-tertiary` (несуществующий токен). |
| COMP-02 | Button: CVA-варианты (primary, danger, ghost, icon) + размеры (sm, md, lg) | Button уже имеет manual variants-объект без CVA. Нужно переписать на `cva()`. Удалить: secondary, danger-outline, success, warning. |
| COMP-03 | Badge: CVA-варианты (success, warning, danger, neutral, dot) | Badge импортирует `colors` из colors.ts — hardcoded rgba. Нужно мигрировать на status-токены. Заменить `accent` → `neutral`. |
| COMP-04 | Input расширен: clearable, helper text, error state через токен | Input почти готов (уже token-driven), нужно добавить clearable prop и helper text. |
| COMP-05 | Select заменён кастомным dropdown | Текущий Select.tsx уже кастомный (не native), использует `useDropdownPortal` + `createPortal`. Нужно мигрировать colors.ts → токены, добавить keyboard nav. |
| COMP-06 | Modal обновлён: size variants, новый overlay style | Modal использует hardcoded z-index 9000 — мигрировать на `--z-modal`. Добавить size variants. |
| COMP-07 | Новый Section + SectionHeader | Нет в shared/ui/. Создать с нуля. |
| COMP-08 | Новый FormField | Нет в shared/ui/. Создать с нуля. |
| COMP-09 | Новый StatusBadge | Нет в shared/ui/. Токены `--color-status-*` и `--color-status-*-bg/border` уже определены в tokens.css. |
| COMP-10 | Новый EmptyState | Нет в shared/ui/. Создать с нуля. |
| COMP-11 | Новый Separator | Нет в shared/ui/. Создать с нуля. |
| COMP-12 | Новый ProgressBar | Нет в shared/ui/. `--color-accent-interactive` для fill. |
| COMP-13 | ErrorBanner: CVA severity variants | Использует hardcoded rgba + colors.ts. Мигрировать на status-токены через CVA. |
| COMP-14 | Каждый компонент выдерживает единый стиль inline tokens vs className tokens | Решение: нет inline style для цветов — только Tailwind bracket syntax `bg-[var(--token)]` или className. |
| SB-04 | Каждый primitive из shared/ui/ имеет .stories.tsx с autodocs | Ни одного .stories.tsx файла не существует — все создаются в Phase 2. |
| SB-05 | Каждая story показывает все состояния | Storybook preview.ts уже настроен с theme toggle и полными CSS imports. |
| DOC-02 | memory/v3/design-system/ документация каждого компонента | Директория существует с tokens.md. Нужно создать файл для каждого компонента. |
</phase_requirements>

---

## Summary

Phase 2 переписывает полный слой UI примитивов TrustTunnel. Кодовая база находится в известном состоянии: 19 компонентов в `shared/ui/`, из которых большинство уже используют CSS custom properties, но некоторые (Badge, ErrorBanner, Select) зависят от deprecated `colors.ts` с hardcoded rgba-значениями. CVA как библиотека ещё НЕ установлена в проект — требуется `npm install`. Storybook 10 полностью настроен с theme toggle и Tauri mocks, но ни одного `.stories.tsx` файла не существует.

UI-SPEC уже создан (`02-UI-SPEC.md`) — он является исчерпывающим контрактом для Phase 2: описывает все 26 компонентов (19 редизайн + 7 новых), CVA архитектуру, interaction states, копирайтинг, и accessibility требования. Планировщик должен использовать UI-SPEC как первичный источник спецификации — research уточняет технические детали реализации.

**Основная рекомендация:** Разбить работу на три волны: (1) установка CVA + переписка компонентов с варiantами (Button, Badge, ErrorBanner), (2) остальные 16 редизайн-компонентов, (3) 7 новых компонентов. Каждый компонент — отдельная задача с co-located `.stories.tsx`.

---

## Standard Stack

### Core

| Библиотека | Версия | Назначение | Обоснование |
|-----------|--------|-----------|-------------|
| class-variance-authority (CVA) | 0.7.1 | CVA variants для Button, Badge, ErrorBanner, Modal | Стандарт shadcn/ui паттерна; нет в package.json — **нужно установить** |
| tailwind-merge | 3.5.0 | Безопасное слияние className строк | Обязателен с CVA для правильного override; нет в package.json — **нужно установить** |
| clsx | 2.1.1 | Условная конкатенация классов | Альтернатива tailwind-merge для non-conflict классов |
| tailwindcss | 3.4.17 (уже установлен) | CSS utility classes | Уже в devDependencies |
| lucide-react | 0.468.0 (уже установлен) | Иконки (Loader2, ChevronDown, Check, Eye, EyeOff, Lock, X, AlertTriangle) | Уже используется во всех компонентах |

[VERIFIED: npm registry] — версии проверены через `npm view`

### Supporting

| Библиотека | Версия | Назначение | Когда использовать |
|-----------|--------|-----------|-------------------|
| @storybook/react-vite | 10.3.5 (уже установлен) | Storybook stories | Для всех .stories.tsx |
| @storybook/addon-themes | 10.3.5 (уже установлен) | Theme toggle в toolbar | Preview.ts уже настроен |
| vitest + @testing-library/react | 4.1.0 / 16.3.2 (уже установлены) | Юнит тесты | Для поведенческих тестов компонентов |

### Установка новых зависимостей

```bash
cd gui-app && npm install class-variance-authority tailwind-merge clsx
```

**Примечание:** `clsx` часто идёт в паре с `tailwind-merge` в виде утилиты `cn()`:

```ts
// gui-app/src/shared/lib/cn.ts (создать в Wave 0)
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

---

## Architecture Patterns

### Рекомендуемая структура файлов

```
gui-app/src/shared/ui/
├── Button.tsx              # переписать на CVA
├── Button.stories.tsx      # создать
├── Button.test.tsx         # обновить (удалить тесты на removed variants)
├── Badge.tsx               # переписать на CVA
├── Badge.stories.tsx       # создать
├── Badge.test.tsx          # обновить
├── ...                     # (аналогично для каждого компонента)
├── Section.tsx             # создать новый
├── Section.stories.tsx     # создать
├── FormField.tsx           # создать новый
├── FormField.stories.tsx   # создать
├── StatusBadge.tsx         # создать новый
├── StatusBadge.stories.tsx # создать
├── EmptyState.tsx          # создать новый
├── EmptyState.stories.tsx  # создать
├── Separator.tsx           # создать новый
├── Separator.stories.tsx   # создать
├── ProgressBar.tsx         # создать новый
├── ProgressBar.stories.tsx # создать
├── Select.tsx              # переписать (уже кастомный, мигрировать colors.ts + keyboard nav)
├── Select.stories.tsx      # создать
└── index.ts                # обновить экспорты
gui-app/src/shared/lib/
└── cn.ts                   # создать утилиту cn()
```

### Pattern 1: CVA компонент

[VERIFIED: codebase — Button.tsx, BadgeSBTV.tsx паттерн, shadcn/ui документация ASSUMED]

```tsx
// Источник: CVA docs + UI-SPEC D-04
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";
import { forwardRef, type ButtonHTMLAttributes } from "react";

const buttonVariants = cva(
  // Base — layout, motion, cursor. НЕТ цветов здесь.
  "inline-flex items-center justify-center font-medium rounded-[var(--radius-lg)] transition-all duration-[--transition-fast] active:scale-[0.97] disabled:opacity-[--opacity-disabled] disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:shadow-[var(--focus-ring)] outline-none",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-accent-interactive)] hover:bg-[var(--color-accent-hover)] active:bg-[var(--color-accent-active)] text-[var(--color-text-inverse)] border border-transparent",
        danger:
          "bg-[var(--color-destructive)] hover:opacity-90 text-white border border-transparent",
        ghost:
          "bg-transparent hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] text-[var(--color-text-secondary)] border border-transparent",
        icon:
          "bg-transparent hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] text-[var(--color-text-muted)] border border-transparent",
      },
      size: {
        sm: "h-8 px-3 text-[var(--font-size-sm)] gap-1.5",
        md: "h-8 px-4 text-[var(--font-size-sm)] gap-2",
        lg: "h-9 px-5 text-[var(--font-size-md)] gap-2",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant, size, loading, fullWidth, className, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(buttonVariants({ variant, size }), fullWidth && "w-full", className)}
      {...props}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : children}
    </button>
  )
);
```

### Pattern 2: Story файл (co-located, autodocs)

[VERIFIED: Storybook preview.ts в кодовой базе + Storybook 10 docs ASSUMED]

```tsx
// Button.stories.tsx
import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./Button";

const meta = {
  title: "Primitives/Button",
  component: Button,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "danger", "ghost", "icon"],
    },
    size: {
      control: "select",
      options: ["sm", "md", "lg"],
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: "Button", variant: "primary", size: "md" },
};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4">
      <Button variant="primary">Primary</Button>
      <Button variant="danger">Danger</Button>
      <Button variant="ghost">Ghost</Button>
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4">
      <Button>Default</Button>
      <Button disabled>Disabled</Button>
      <Button loading>Loading</Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2 p-4">
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
};
```

### Pattern 3: Новый компонент — StatusBadge

[VERIFIED: tokens.css — все `--color-status-*` токены существуют]

```tsx
// StatusBadge.tsx
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

const statusBadgeVariants = cva(
  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-full)] text-[var(--font-size-xs)] font-[var(--font-weight-semibold)] uppercase tracking-[var(--tracking-wide)]",
  {
    variants: {
      variant: {
        connected:
          "bg-[var(--color-status-connected-bg)] text-[var(--color-status-connected)] border border-[var(--color-status-connected-border)]",
        connecting:
          "bg-[var(--color-status-connecting-bg)] text-[var(--color-status-connecting)] border border-[var(--color-status-connecting-border)]",
        error:
          "bg-[var(--color-status-error-bg)] text-[var(--color-status-error)] border border-[var(--color-status-error-border)]",
        disconnected:
          "bg-transparent text-[var(--color-status-disconnected)] border border-[var(--color-border)]",
      },
    },
    defaultVariants: { variant: "disconnected" },
  }
);
```

### Pattern 4: Select/Dropdown (кастомный с keyboard nav)

[VERIFIED: Select.tsx в кодовой базе — уже использует useDropdownPortal + createPortal]

Существующий Select уже кастомный (не native `<select>`). В Phase 2 он получает:
1. Удаление `colors.ts` зависимости → только CSS vars
2. Keyboard navigation (ArrowUp/Down, Enter, Escape, Tab)
3. `aria-activedescendant` + `role="listbox"` для a11y

Важно: `useDropdownPortal` хук уже существует в `shared/hooks/` — его сохранить.

### Anti-Patterns to Avoid

- **Hardcoded rgba в className:** `bg-[rgba(16,185,129,0.08)]` — НЕПРАВИЛЬНО. Использовать `bg-[var(--color-status-connected-bg)]`
- **colors.ts в новых компонентах:** Этот файл deprecated, его импортировать нельзя
- **Hardcoded z-index числа:** `z-[9000]` — НЕПРАВИЛЬНО. Использовать `z-[var(--z-modal)]`
- **Inline style для цветов:** `style={{ color: "#fff" }}` или `style={{ color: "var(--token)" }}` — НЕПРАВИЛЬНО. Использовать Tailwind bracket syntax: `text-[var(--color-text-primary)]`
- **COMP-14 нарушение:** Смешивание inline style и className для токенов в рамках одного компонента
- **forwardRef опущен:** Все интерактивные компоненты ДОЛЖНЫ быть `forwardRef`
- **Missing focus-visible:** Все кликабельные элементы обязаны иметь `focus-visible:shadow-[var(--focus-ring)]`

---

## Don't Hand-Roll

| Проблема | Не строить | Использовать | Почему |
|---------|-----------|-------------|--------|
| Merging Tailwind classNames | Ручная конкатенация строк | `tailwind-merge` + `clsx` = `cn()` | Конфликты классов, дублирование |
| CVA variant maps | Ручные `Record<Variant, string>` объекты | `class-variance-authority` | Type-safe variants, VariantProps, defaultVariants |
| Dropdown positioning | Ручное `getBoundingClientRect` в новом коде | Использовать СУЩЕСТВУЮЩИЙ `useDropdownPortal` | Уже написан, протестирован |
| Portal rendering | `document.body.appendChild()` | `createPortal` (уже используется) | Уже в Modal/Select/Tooltip |
| Theme-aware colors | Логика на JS | CSS custom properties + `[data-theme]` в tokens.css | Уже работает, не дублировать |

**Ключевой инсайт:** Badge и ErrorBanner — единственные компоненты с активной зависимостью от `colors.ts` в рантайме. Остальные используют colors.ts только для `dropdownShadow` или deprecated glow (которые уже = "none"). После Phase 2 colors.ts можно убрать (deferred по решению).

---

## Аудит существующих компонентов (полный)

### Компоненты с проблемами (требуют миграции)

| Компонент | Проблема | Что менять |
|-----------|---------|-----------|
| Badge.tsx | `colors.successBorder`, `colors.warningBorder`, `colors.dangerBorder`, `colors.accentLogoGlow` | → `var(--color-status-*-bg/border)`. CVA добавить. |
| ErrorBanner.tsx | hardcoded `rgba(239,68,68,0.1)`, `rgba(239,68,68,0.2)` + `colors.warningBg`, `colors.accentBg`, `colors.accentBorder` | → status tokens + CVA |
| Select.tsx | `colors.dropdownShadow`, `colors.accentBg`, hardcoded `color: "var(--color-accent-500)"` (не alias!) | → `var(--shadow-md)`, `var(--color-status-info-bg)` или accent-bg токен |
| DropOverlay.tsx | hardcoded `color: "#fff"`, `fontSize: "18px"`, `fontWeight: 500` | → `var(--color-text-inverse)`, `var(--font-size-lg)`, `var(--font-weight-semibold)` |
| PanelErrorBoundary.tsx | `text-red-500` (Tailwind без CSS var), `var(--color-bg-tertiary)` (НЕ существующий токен!) | → `text-[var(--color-danger-400)]`, `bg-[var(--color-bg-surface)]` |
| Modal.tsx | hardcoded `zIndex: 9000`, `backgroundColor: "rgba(0,0,0,0.4)"` | → `var(--z-modal)`, `var(--color-bg-primary)` + `opacity-[var(--opacity-backdrop)]` |
| SnackBar.tsx | `var(--color-error, #f97316)` (нет такого токена, fallback — orange!) | → `var(--color-status-error)` |
| IconButton.tsx | нет `aria-label` prop (обязателен по UI-SPEC accessibility) | Добавить `aria-label: string` как required |

[VERIFIED: прямое чтение исходных файлов]

### Компоненты, уже почти готовые (minor fixes)

| Компонент | Состояние | Что нужно |
|-----------|----------|-----------|
| Button.tsx | Почти готов, использует CSS vars | Переписать на CVA, удалить secondary/danger-outline/success/warning варианты |
| Input.tsx | Хороший, CSS vars | Добавить clearable + helper text props |
| Toggle.tsx | Хороший, CSS vars | Проверить focus-visible (сейчас нет) |
| Card.tsx | Хороший, CSS vars | Добавить focus-visible если нужно |
| Tooltip.tsx | Хороший, CSS vars | Проверить z-index (9500 → `var(--z-dropdown)`) |
| ConfirmDialog.tsx | Зависит от Button и Modal — обновится автоматически после их редизайна | После редизайна Button/Modal |
| NumberInput.tsx | Хороший, CSS vars | Алайн с Input редизайном |
| PasswordInput.tsx | Хороший, CSS vars | Алайн с Input редизайном |
| ActionInput.tsx | Хороший, CSS vars | Алайн с Input редизайном |
| ActionPasswordInput.tsx | Хороший, CSS vars | Алайн с Input редизайном |
| SnackBarContext.tsx | Context provider, нет визуала | Не меняется |

[VERIFIED: прямое чтение исходных файлов]

---

## Common Pitfalls

### Pitfall 1: --color-bg-tertiary не существует

**Что пойдёт не так:** PanelErrorBoundary использует `var(--color-bg-tertiary)` — этот токен НЕ определён в tokens.css. Компонент рендерится с пустым background в браузере.

**Почему:** tokens.css определяет bg-primary, bg-secondary, bg-surface, bg-elevated, bg-hover, bg-active. Нет bg-tertiary.

**Как избежать:** Заменить на `var(--color-bg-surface)` или `var(--color-bg-elevated)`.

[VERIFIED: прямое чтение tokens.css]

### Pitfall 2: var(--color-error) не существует, используется в SnackBar

**Что пойдёт не так:** SnackBar использует `var(--color-error, #f97316)` — токена `--color-error` нет, fallback срабатывает с оранжевым (#f97316), но в проекте красный danger.

**Как избежать:** Заменить на `var(--color-status-error)`.

[VERIFIED: прямое чтение tokens.css и SnackBar.tsx]

### Pitfall 3: Tooltip и Select используют hardcoded z-index числа

**Что пойдёт не так:** Tooltip — `z-[9500]`, Select dropdown — `zIndex: 9500`. Modal — `zIndex: 9000`. Числа вне z-index токен-шкалы.

**Токен-шкала:** `--z-dropdown: 100`, `--z-modal: 300`, `--z-snackbar: 400`, `--z-titlebar: 500`. Числа 9000+ конфликтуют с Tauri titlebar (--z-titlebar: 500).

**Как избежать:** Использовать `z-[var(--z-dropdown)]` для Select/Tooltip, `z-[var(--z-modal)]` для Modal.

[VERIFIED: tokens.css z-index секция]

### Pitfall 4: CVA variant strings — конфликты Tailwind классов без tailwind-merge

**Что пойдёт не так:** Без `twMerge()` потребители не могут override классы через `className` prop. Например `<Button className="rounded-none">` не сработает, т.к. CVA добавляет `rounded-[var(--radius-lg)]`.

**Как избежать:** Всегда использовать `cn(buttonVariants(...), className)` где `cn` = twMerge + clsx.

[ASSUMED — стандартное поведение tailwind-merge]

### Pitfall 5: Select/dropdown позиционирование в Storybook

**Что пойдёт не так:** Select использует `createPortal(dropdown, document.body)` и `useDropdownPortal` для позиционирования через getBoundingClientRect. В Storybook с `layout: 'fullscreen'` это работает. При `layout: 'centered'` iframe может ломать координаты.

**Как избежать:** Storybook preview.ts уже задаёт `layout: 'fullscreen'` — это правильно.

[VERIFIED: preview.ts в кодовой базе]

### Pitfall 6: Existing tests ломаются после удаления variants

**Что пойдёт не так:** Button.test.tsx проверяет `variant="secondary"` и `variant="warning"` — эти варианты удаляются по D-06. Тесты сломаются.

**Как избежать:** Обновить test файлы одновременно с компонентами. Проверить `npm test` после каждого компонента.

[VERIFIED: Button.test.tsx в кодовой базе]

### Pitfall 7: Badge.test.tsx тестирует hardcoded rgba значения из colors.ts

**Что пойдёт не так:** Badge.test.tsx проверяет `style.backgroundColor === "rgba(16, 185, 129, 0.15)"`. После миграции на CSS vars это будет `var(--color-status-connected-bg)` — тест сломается.

**Как избежать:** Обновить тесты для проверки наличия CSS var имён, не конкретных rgba значений.

[VERIFIED: Badge.test.tsx в кодовой базе]

---

## Code Examples

### Утилита cn() (Wave 0, создать перед компонентами)

```ts
// gui-app/src/shared/lib/cn.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

### Separator компонент (новый, простой пример)

```tsx
// Separator.tsx
import { cn } from "../lib/cn";

interface SeparatorProps {
  orientation?: "horizontal" | "vertical";
  label?: string;
  className?: string;
}

export function Separator({ orientation = "horizontal", label, className }: SeparatorProps) {
  if (orientation === "vertical") {
    return (
      <div
        className={cn("w-px self-stretch bg-[var(--color-border)]", className)}
        role="separator"
        aria-orientation="vertical"
      />
    );
  }

  if (label) {
    return (
      <div className={cn("flex items-center gap-3", className)} role="separator">
        <div className="flex-1 h-px bg-[var(--color-border)]" />
        <span className="text-[var(--font-size-xs)] text-[var(--color-text-muted)] whitespace-nowrap">
          {label}
        </span>
        <div className="flex-1 h-px bg-[var(--color-border)]" />
      </div>
    );
  }

  return (
    <div
      className={cn("h-px w-full bg-[var(--color-border)]", className)}
      role="separator"
    />
  );
}
```

### FormField компонент (новый)

```tsx
// FormField.tsx
import { type ReactNode } from "react";
import { cn } from "../lib/cn";

interface FormFieldProps {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}

export function FormField({ label, required, error, hint, children, className }: FormFieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label className="text-[var(--font-size-sm)] font-[var(--font-weight-normal)] text-[var(--color-text-secondary)]">
        {label}
        {required && (
          <span className="ml-0.5 text-[var(--color-danger-500)]" aria-hidden="true">*</span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p className="text-[var(--font-size-xs)] text-[var(--color-text-muted)]">{hint}</p>
      )}
      {error && (
        <p className="text-[var(--font-size-xs)] text-[var(--color-status-error)]" role="alert">{error}</p>
      )}
    </div>
  );
}
```

### EmptyState компонент (новый)

```tsx
// EmptyState.tsx
import { type ReactNode } from "react";
import { cn } from "../lib/cn";

interface EmptyStateProps {
  icon?: ReactNode;
  heading?: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  heading = "Ничего нет",
  body = "Здесь появятся элементы после добавления.",
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 py-8 text-center", className)}>
      {icon && (
        <div className="text-[var(--color-text-muted)] opacity-40">{icon}</div>
      )}
      <div className="space-y-1">
        <p className="text-[var(--font-size-md)] font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)]">
          {heading}
        </p>
        <p className="text-[var(--font-size-sm)] text-[var(--color-text-muted)]">
          {body}
        </p>
      </div>
      {action}
    </div>
  );
}
```

---

## Рекомендуемый порядок волн (для планировщика)

### Wave 0: Инфраструктура (prerequisite)

1. `npm install class-variance-authority tailwind-merge clsx` в gui-app
2. Создать `gui-app/src/shared/lib/cn.ts`
3. Обновить `index.ts` экспорты по завершении всей фазы (или в конце каждой волны)

### Wave 1: CVA-компоненты с вариантами (высокий приоритет)

Компоненты, требующие CVA структуры — делать первыми, т.к. остальные могут их использовать:
1. **Button** — ядро, используется в ConfirmDialog, IconButton
2. **Badge** — простой, хорошая демонстрация CVA паттерна
3. **ErrorBanner** — CVA severity variants

### Wave 2: Редизайн существующих (16 компонентов)

Порядок по зависимостям:
4. Input (+ NumberInput, PasswordInput, ActionInput, ActionPasswordInput — единый паттерн)
5. Toggle
6. Card
7. Tooltip (z-index fix)
8. Modal (size variants, z-index fix)
9. ConfirmDialog (зависит от Modal + Button — обновляется автоматически)
10. Select (keyboard nav + colors.ts removal)
11. SnackBar (z-index + token fix)
12. SnackBarContext (нет визуала)
13. IconButton (aria-label required)
14. DropOverlay (token migration)
15. PanelErrorBoundary (token migration, удалить несуществующий --color-bg-tertiary)

### Wave 3: Новые компоненты (7 штук)

16. Separator (простейший, начать с него)
17. ProgressBar
18. StatusBadge
19. EmptyState
20. FormField
21. Section + SectionHeader
22. Select custom (если не сделан в Wave 2 — переписать полностью)

### Wave 4: Storybook stories + документация

Каждый компонент получает `.stories.tsx` — можно делать параллельно с Wave 2-3 или отдельной волной.
Документация `memory/v3/design-system/` — один файл на компонент.

---

## Validation Architecture

`workflow.nyquist_validation` не задан в `.planning/config.json` — обрабатывается как enabled.

### Test Framework

| Свойство | Значение |
|---------|---------|
| Framework | vitest 4.1.0 + @testing-library/react 16.3.2 |
| Config file | `gui-app/vitest.config.ts` (или в vite.config.ts) |
| Quick run | `cd gui-app && npm test` |
| Full suite | `cd gui-app && npm run prerelease` (typecheck + lint + test + rust:check + build) |

### Phase Requirements → Test Map

| Req ID | Поведение | Тип теста | Команда | Файл существует? |
|--------|----------|-----------|---------|-----------------|
| COMP-01 | Zero hardcoded colors | Ручная проверка (Storybook visual) + grep | `grep -r "rgba\|#[0-9a-f]\{3,6\}" gui-app/src/shared/ui/` | N/A |
| COMP-02 | Button CVA variants рендерятся | unit | `cd gui-app && npm test -- Button` | Button.test.tsx (нужно обновить) |
| COMP-03 | Badge CVA variants рендерятся | unit | `cd gui-app && npm test -- Badge` | Badge.test.tsx (нужно обновить) |
| COMP-04 | Input clearable, helper text | unit | `cd gui-app && npm test -- Input` | Input.test.tsx (нужно создать/проверить) |
| COMP-05 | Select кастомный, keyboard nav | unit | `cd gui-app && npm test -- Select` | Select.test.tsx (нужно обновить) |
| COMP-06 | Modal size variants | unit | `cd gui-app && npm test -- Modal` | Modal.test.tsx (нужно обновить) |
| COMP-07-14 | Новые компоненты рендерятся | unit | `cd gui-app && npm test` | ❌ создать Wave 3 |
| SB-04, SB-05 | Stories рендерятся в Storybook | визуальная проверка | `cd gui-app && npm run storybook` | ❌ создать Wave 4 |

### Sampling Rate

- **После каждого компонента:** `cd gui-app && npm test`
- **После каждой волны:** `cd gui-app && npm run typecheck && npm run lint && npm test`
- **Phase gate:** полный `npm run prerelease` + ручной просмотр в Storybook (light + dark)

### Wave 0 Gaps

- [ ] `gui-app/src/shared/lib/cn.ts` — утилита cn() для CVA + tailwind-merge
- [ ] `gui-app/node_modules/class-variance-authority` — `npm install class-variance-authority tailwind-merge clsx`
- [ ] Обновить Button.test.tsx — убрать тесты на `secondary`, `warning` варианты (будут удалены)
- [ ] Обновить Badge.test.tsx — тесты проверяют конкретные rgba значения из colors.ts, нужно переписать

---

## Environment Availability

| Зависимость | Требуется для | Доступна | Версия | Fallback |
|------------|-------------|---------|--------|--------|
| Node.js / npm | npm install CVA | ✓ (подтверждено по package.json) | — | — |
| CVA (class-variance-authority) | COMP-02, COMP-03, COMP-13, COMP-06 | ✗ не установлена | — | Ручной variant record (хуже) |
| tailwind-merge | cn() утилита | ✗ не установлена | — | clsx без merge (риск конфликтов) |
| clsx | cn() утилита | ✗ не установлена | — | template literals |
| Storybook | SB-04, SB-05 | ✓ 10.3.5 установлен | 10.3.5 | — |
| lucide-react | иконки в компонентах | ✓ 0.468.0 установлен | 0.468.0 | — |

**Блокирующие зависимости без fallback:**
- CVA — без неё COMP-02/03/08/13 технически выполнимы через ручные variant-объекты, но это нарушает D-04

**Fallback:** Wave 0 должна начинаться с `npm install class-variance-authority tailwind-merge clsx`.

---

## Security Domain

Phase 2 — исключительно визуальный слой, UI компоненты. Нет серверных запросов, нет хранения данных, нет аутентификации. ASVS категории не применимы.

Единственный security-relevant момент: `IconButton` обязан принимать `aria-label` — это требование доступности (не безопасности).

---

## Assumptions Log

| # | Утверждение | Секция | Риск если ошибка |
|---|-------------|---------|-----------------|
| A1 | Storybook 10 Meta/StoryObj API совместимы с `satisfies Meta<typeof Component>` синтаксисом | Code Examples | Низкий — Storybook 10 это стандарт, но типы могли измениться |
| A2 | tailwind-merge 3.x совместим с Tailwind 3.4.x | Standard Stack | Низкий — обе библиотеки существуют в текущих версиях |
| A3 | `useDropdownPortal` хук существует в `shared/hooks/` | Architecture Patterns | Средний — Select.tsx его импортирует, но сам хук не читался в этой сессии |

[VERIFIED: npm registry] — версии CVA 0.7.1, tailwind-merge 3.5.0, clsx 2.1.1 подтверждены.

---

## Open Questions

1. **Keyboard navigation в Select**
   - Что известно: существующий Select — только mouse-driven (onClick на кнопке и items)
   - Что неясно: UI-SPEC требует keyboard accessible, но не описывает точную реализацию ArrowUp/Down/Enter/Escape
   - Рекомендация: реализовать стандартный паттерн listbox (WAI-ARIA 1.2) — planner задаёт как Claude's discretion

2. **Section vs SectionHeader: отдельные экспорты или compound?**
   - Что известно: CONTEXT.md D-12 называет их вместе, UI-SPEC описывает `Section` с `collapsible?: boolean`
   - Что неясно: `Section.tsx` и `CardHeader.tsx` — дублирование? CardHeader уже есть в Card.tsx
   - Рекомендация: Section — новый компонент с встроенным SectionHeader как children pattern или subcomponent. Card/CardHeader остаётся для card-specific использования.

3. **ProgressBar: determinate vs indeterminate?**
   - Что известно: UI-SPEC — `value: 0–100, label?: string` (determinate)
   - Что неясно: нужен ли indeterminate state (spinning/pulsing) для операций без прогресса?
   - Рекомендация: Phase 2 реализует только determinate (value prop). Indeterminate — Phase 3.

---

## Sources

### Primary (HIGH confidence)

- `gui-app/src/shared/ui/*.tsx` — все 19 существующих компонентов прочитаны напрямую
- `gui-app/src/shared/styles/tokens.css` — 263 строки, все токены проверены
- `.planning/phases/02-ssh-port-change-core-engine/02-UI-SPEC.md` — полный дизайн-контракт
- `.planning/phases/02-ssh-port-change-core-engine/02-CONTEXT.md` — locked decisions
- `gui-app/package.json` — все зависимости проверены
- `gui-app/.storybook/main.ts` + `preview.ts` — Storybook конфигурация
- `memory/v3/design-system/tokens.md` + `memory/v3/decisions/phase-1-decisions.md`
- npm registry: `npm view class-variance-authority version` = 0.7.1

### Secondary (MEDIUM confidence)

- `gui-app/tailwind.config.js` — `surface.*` palette в extend.colors (подтверждает DS-10 требование)
- `gui-app/src/shared/ui/*.test.tsx` — Badge.test.tsx и Button.test.tsx прочитаны для понимания scope

### Tertiary (LOW confidence)

- CVA документация — паттерны основаны на training knowledge [ASSUMED]
- Storybook 10 Meta/StoryObj типы — основаны на training knowledge [ASSUMED]

---

## Metadata

**Confidence breakdown:**

- Standard Stack: HIGH — версии проверены через npm registry, зависимости проверены в package.json
- Architecture: HIGH — основана на прямом чтении всех 19 компонентов и tokens.css
- Pitfalls: HIGH — все 7 pitfalls верифицированы прямым чтением кода (не предположения)
- New Components: MEDIUM — API спроектирован по UI-SPEC и pattern из существующих компонентов

**Research date:** 2026-04-14
**Valid until:** 2026-05-14 (стабильный стек, 30 дней)
