<!-- generated-by: gsd-doc-writer -->
# Тестирование

Руководство для разработчиков, которые пишут или запускают тесты в TrustTunnel
Client. Базовые команды запуска — в `GETTING-STARTED.md`. Общие правила
паттернов — в `CLAUDE.md` → раздел **Testing Patterns**.

## Стек тестирования

- **Vitest 4** (`vitest run`) — основной тест-раннер для фронтенда.
- **React Testing Library** (`@testing-library/react`, `user-event`,
  `jest-dom`) — рендер и взаимодействие.
- **jsdom 29** — окружение DOM (`gui-pro/vite.config.ts` →
  `test.environment: "jsdom"`).
- **Storybook 10** (`storybook/test`) — interactive-stories с `play()`.
- **Cargo test** — юнит-тесты бэкенда (Rust / Tauri commands).

Конфигурация — в `gui-pro/vite.config.ts` (секция `test:`): `globals: true`,
`setupFiles: ["./src/test/setup.ts"]`, `include: ["src/**/*.test.{ts,tsx}"]`.
Объём: **1393+ тестов** в **105 файлах** под `gui-pro/src/**`.

Глобальный setup `gui-pro/src/test/setup.ts` импортирует
`@testing-library/jest-dom`, `./tauri-mock`, `../shared/i18n` и подменяет
`requestAnimationFrame` на синхронный колбэк (см. «Паттерны»).

## Команды запуска

Все команды — из `gui-pro/` (если не указано иное).

```bash
# Все тесты (единичный прогон, CI-режим)
npm run test

# Watch-режим
npm run test:watch

# Один файл
npx vitest run src/shared/ui/Button.test.tsx

# Один тест по имени (substring match)
npx vitest run -t "renders primary variant"

# Полный пререлизный прогон
npm run prerelease
```

Бэкенд на Rust (из `gui-pro/src-tauri/`):

```bash
cargo test
```

## Паттерны

### Visibility вместо DOM-existence

Табы и Accordion переключаются через `visibility: hidden` + `opacity: 0`,
а не `display: none` — элемент **остаётся в DOM**. Поэтому:

```tsx
// ❌ Неправильно — элемент в DOM, тест упадёт
expect(hiddenPanel).not.toBeInTheDocument();

// ✅ Правильно
expect(hiddenPanel).not.toBeVisible();
```

### Синхронный RAF

`setup.ts` заменяет `requestAnimationFrame` на синхронный колбэк. Это
критично для Modal / pill-индикатора / cross-fade табов: анимации
выполняются мгновенно, `waitFor` не нужен для RAF-эффектов.

### i18n в `beforeEach`

Для компонентов с `useTranslation()` язык фиксируется перед каждым тестом:

```ts
import i18n from "../../shared/i18n";

beforeEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage("ru");
});
```

### Что проверять: поведение, aria, visibility — не CSS-классы

```tsx
// ✅ Поведение и ARIA
expect(button).toHaveAttribute("aria-expanded", "true");
expect(panel).toBeVisible();
expect(screen.getByRole("button", { name: "Сохранить" })).toBeDisabled();

// ❌ CSS-класс (хрупко, ломается при смене стилей)
expect(div).toHaveClass("open");
```

Исключение — когда класс единственный наблюдаемый признак (например,
`animate-spin` на SVG-спиннере). Предпочитайте `role`, `aria-*`,
`toBeVisible()`, `toBeDisabled()`.

## Пример (из `Button.test.tsx`)

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "./Button";

describe("Button", () => {
  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Press</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled state: button has disabled attr, onClick not called", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>No</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
```

Обратите внимание: `getByRole("button")` вместо селекторов по классу,
`toBeDisabled()` вместо `toHaveClass("disabled")`.

## Tauri-моки

Глобальные моки Tauri API — `gui-pro/src/test/tauri-mock.ts` (подгружается
через `setup.ts`). Замоканы: `@tauri-apps/api/core` (`invoke`), `/event`,
`/app`, `/window`, `plugin-dialog`, `plugin-shell`. По умолчанию `invoke`
возвращает `null`. В тестах, где нужен конкретный ответ — переопределяйте
per-test:

```ts
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValueOnce({ users: ["alice"] });
});
```

Activity log мокается так же (`../../shared/hooks/useActivityLog`) —
см. `UsersSection.test.tsx` как образец (шпион `activityLogSpy` проверяет
отсутствие утечек паролей в логи).

Storybook использует отдельный набор заглушек в
`gui-pro/.storybook/tauri-mocks/` (6 файлов: `api-app.ts`, `api-core.ts`,
`api-event.ts`, `api-window.ts`, `plugin-dialog.ts`, `plugin-shell.ts`).

Если компонент использует `SnackBarProvider` / `ConfirmDialogProvider` —
рендерьте через `renderWithProviders` из `gui-pro/src/test/test-utils.tsx`.

## Storybook-тесты

Интерактивные сценарии пишутся в `play:`-функции story через `userEvent`
и `within` из `storybook/test`. Пример — `WithUserConfigModal` в
`gui-pro/src/components/server/UsersSection.stories.tsx`:

```tsx
import { userEvent, within, waitFor } from "storybook/test";

export const WithUserConfigModal: Story = {
  args: { state: createMockServerState({ /* ... */ }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const buttons = await canvas.findAllByLabelText(/показать конфиг|show config/i);
    if (buttons.length > 0) await userEvent.click(buttons[0]);
    await waitFor(() => {
      const modal = document.body.querySelector('[aria-label*="скопировать"i]');
      // ...
    });
  },
};
```

Интерактивные stories используют `useState` внутри `render()` — чтобы
демонстрировать смену состояния без внешнего провайдера.

## Покрытие

**Автоматического coverage-gate нет** — покрытие отслеживается вручную при
ревью. `@vitest/coverage-v8` подключён (`npx vitest run --coverage`
генерирует HTML-отчёт), но в `prerelease` не входит.

При создании нового компонента обязательны:

1. **Story-файл** (`*.stories.tsx`) — минимум один вариант; интерактивные
   сценарии используют `useState` в `render()`.
2. **Тест-файл** (`*.test.tsx`) — покрывает CVA-варианты, состояния
   (disabled, loading, error), a11y-атрибуты.
3. **Интеграция в тест фичи-потребителя** — если компонент встроен в
   `ServerPanel` / `ControlPanelPage`, добавить проверку в
   соответствующий `*.test.tsx` фичи.

## См. также

- `CLAUDE.md` → **Testing Patterns**, **Gotchas** — чек-лист паттернов
- `GETTING-STARTED.md` — первый запуск и базовые команды
- `DEVELOPMENT.md` — линт, форматирование, PR-процесс
- `memory/v3/design-system/storybook.md` — инвентаризация story-файлов
