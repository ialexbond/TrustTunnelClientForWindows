# Design System Components — Current `gui-pro` Reference

> Updated: 2026-04-20
> Source of truth: `gui-pro/src/shared/ui/` and `gui-pro/src/shared/styles/tokens.css`

---

## Что это за документ

Это рабочий каталог текущей дизайн-системы Pro UI.

Он нужен, чтобы:

- быстро понять, где живет shared UI
- увидеть актуальный набор primitives и patterns
- не путать shipped `gui-pro` с ранними phase-2 заметками про `gui-app`

Если этот документ расходится с кодом, править нужно по коду в `gui-pro/src/shared/ui/`.

## Foundations

### Tokens

Source of truth:

- `gui-pro/src/shared/styles/tokens.css`

Ключевые свойства current tokens:

- primitives + semantic aliases
- dark/light themes
- slate-teal accent palette
- semantic typography tokens
- spacing, radius, z-index, motion, focus-ring tokens
- Geist Sans / Geist Mono as base fonts
- Outfit только для wordmark/display use cases

### Storybook

Source of truth:

- `gui-pro/.storybook/`

Текущее покрытие:

- foundations stories: `Colors`, `Spacing`, `Shadows`, `Typography`
- stories для большинства shared UI primitives
- stories для shell-частей вроде `TabNavigation`, `TitleBar`, `WindowControls`, `ControlPanelPage`, `ServerTabs`

## Актуальный каталог компонентов

### Form primitives

- `Input`
- `NumberInput`
- `PasswordInput`
- `ActionInput`
- `ActionPasswordInput`
- `Select`
- `Toggle`
- `FormField`
- `CIDRPicker`
- `CharCounter`

### Actions and feedback

- `Button`
- `IconButton`
- `Badge`
- `StatusBadge`
- `StatusIndicator`
- `ErrorBanner`
- `SnackBar`
- `SnackBarProvider`
- `useSnackBar`
- `Tooltip`
- `ConfirmDialog`
- `ConfirmDialogProvider`
- `useConfirm`

### Layout and structure

- `Card`
- `CardHeader`
- `Section`
- `SectionHeader`
- `Separator`
- `Divider`
- `Accordion`
- `Modal`

### Empty / loading / overlays

- `EmptyState`
- `DropOverlay`
- `PanelErrorBoundary`
- `ProgressBar`
- `Skeleton`

### Applied patterns

- `OverflowMenu`
- `StatCard`

На 2026-04-20 barrel `gui-pro/src/shared/ui/index.ts` уже экспортирует заметно больше элементов, чем старые phase-2 DOC-02 заметки.

## Ключевые current variants

### Button

Файл:

- `gui-pro/src/shared/ui/Button.tsx`

Текущее состояние:

- построен на `cva`
- variants: `primary`, `secondary`, `danger`, `danger-outline`, `ghost`, `icon`
- sizes: `sm`, `md`, `lg`
- поддерживает `loading`, `icon`, `fullWidth`

### Badge

Файл:

- `gui-pro/src/shared/ui/Badge.tsx`

Текущее состояние:

- построен на `cva`
- variants: `success`, `warning`, `danger`, `neutral`, `dot`, `default`
- sizes: `sm`, `md`
- использует semantic status tokens, а не старый `colors.ts` helper

### ErrorBanner

Файл:

- `gui-pro/src/shared/ui/ErrorBanner.tsx`

Текущее состояние:

- построен на `cva`
- severity variants: `error`, `warning`, `info`
- использует semantic status backgrounds/borders

### StatusBadge

Файл:

- `gui-pro/src/shared/ui/StatusBadge.tsx`

Variants:

- `connected`
- `connecting`
- `error`
- `disconnected`

### StatusIndicator

Файл:

- `gui-pro/src/shared/ui/StatusIndicator.tsx`

Используется как компактный статусный dot/pulse pattern в server-related UI.

## Что появилось после ранних phase-2 заметок

Ниже — элементы, которые уже есть в shipped `gui-pro`, но в старом DOC-02 либо отсутствовали, либо были описаны не как текущий стандарт:

- `Accordion`
- `CIDRPicker`
- `CharCounter`
- `Divider`
- `OverflowMenu`
- `Skeleton`
- `StatCard`
- `StatusIndicator`
- `ConfirmDialogProvider`
- `useConfirm`

## Implementation notes

### CVA

По состоянию на 2026-04-20 `cva` уже используется не только в `StatusBadge`.

Точно используется в:

- `Button`
- `Badge`
- `ErrorBanner`
- `ProgressBar`
- `Skeleton`
- `StatusBadge`
- `StatusIndicator`

### Token-first styling

Компоненты в `gui-pro` строятся поверх `tokens.css`.

Для новых задач это означает:

- сначала искать подходящий semantic token
- потом подбирать variant/pattern
- и только в крайнем случае расширять токены

### Accessibility

По коду и stories видно, что системно учитываются:

- `focus-visible`
- ARIA roles для `Toggle`, `Select`, `ProgressBar`, `Separator`
- keyboard navigation в dropdown/menu/tab patterns
- требование `aria-label` для icon-only actions

## Practical rule

Если нужно понять, существует ли компонент:

1. смотреть `gui-pro/src/shared/ui/index.ts`
2. смотреть конкретный `.tsx`
3. смотреть `.stories.tsx`
4. только потом читать старые phase-2 notes

## Related

- `gui-pro/src/shared/ui/index.ts`
- `gui-pro/src/shared/styles/tokens.css`
- `gui-pro/.storybook/`
- [[v3-design-guidelines]]
- [[frontend]]
