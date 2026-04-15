# Phase 5: Shell Polish + TODO Closure - Research

**Researched:** 2026-04-15
**Domain:** React 19 / Tauri 2 — CSS polish, WAI-ARIA, i18n, Rust sanitize, component state
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Убрать ВСЕ `1px solid var(--color-border)` между shell-компонентами (TitleBar ↔ content ↔ TabBar)
- **D-02:** Разделение только через spacing + тонкие различия фонов. Никаких бордеров.
- **D-04:** Активный таб: оставить elevated pill (bg-elevated, 120×44px). Underline не трогать.
- **D-07:** TitleBar остаётся как есть — пользователь доволен компактным стилем.
- **D-08:** ServerSidebar скрыть полностью при 1 сервере. Показывать только при 2+.
- **D-09:** Удалить статус-точки полностью. Вернуть в multi-server milestone.
- **D-10:** Кнопка "Добавить сервер" НЕ должна дисконнектить активный VPN.
- **D-12:** Исправить невалидные Button variants в ServerPanel (secondary→ghost, success→primary).
- **D-13:** Исправить tab rerender — кешировать состояние вместо unmount.
- **D-14:** ServerTabs НЕ должны ремаунтиться при переключении.
- **D-15:** Auth-кнопки — исправить цвет на light theme (слишком белые).
- **D-16:** Заменить hardcoded Tailwind цвета в sidebar на design tokens.
- **D-17:** Заменить hardcoded RU строки на i18n в Select, StatusBadge, EmptyState.
- **D-18:** Исправить sanitize() — маскировать ВСЕ вхождения чувствительных ключей.
- **D-19:** Disconnect кнопка a11y — `group-focus-within:opacity-100`.

### Claude's Discretion

- **D-03:** Стратегия разделения ServerSidebar ↔ content (bg-secondary vs shadow vs seamless)
- **D-05:** Подход к max-width табов на широких окнах (max-width CSS / center / container)
- **D-06:** Roving focus между табами (WAI-ARIA tablist pattern)
- **D-11:** Easing и длительность анимации появления/скрытия sidebar

### Deferred Ideas (OUT OF SCOPE)

- **ip-dedup-rename** — sidebar скрыт с 1 сервером, дедупликация откладывается на multi-server milestone
- **credentials-persist** — single-server, откладывается
- **shell-disabled-onboarding** — OBSOLETE, hasConfig удалён в Phase 4
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCR-10 | Sidebar редизайнен — токен-based active/hover states, light и dark темы | Все токены существуют. Sidebar уже использует design tokens. Нужно: удалить borders, скрыть при 1 сервере, убрать dots, добавить bg-secondary. |
| SCR-11 | WindowControls редизайнены — token vars, работают как custom title bar | TitleBar/WindowControls зафиксированы (D-07). SCR-11 формально закрывается подтверждением, что TitleBar корректен. Визуально не меняется. |
</phase_requirements>

---

## Summary

Phase 5 — полировка shell и закрытие накопленного backlog. Это не визуальный редизайн с нуля, а точечная доработка Phase 4 outputs: удаление бордеров, сокрытие sidebar при 1 сервере, баг-фиксы кнопок и табов, a11y, i18n и security.

Кодовая база хорошо подготовлена: все дизайн-токены существуют, i18n инфраструктура на месте, компоненты используют CVA. Главный технический риск — ServerTabs: там используется `{activeTab === "X" && <Component />}`, что вызывает полный unmount при переключении. Исправление требует изменения на `display:none` паттерн (как в App.tsx). Это единственное изменение с ненулевым риском регрессии.

Sanitize: функция находится в Rust (`gui-app/src-tauri/src/logging.rs`), уже использует loop-based multi-occurrence поиск — судя по тестам, она **уже корректна** для нескольких вхождений. Перед включением этого таска в план необходима верификация.

**Основная рекомендация:** Разбить Phase 5 на 3 волны: (1) CSS polish + borders, (2) bug fixes + a11y, (3) design-system cleanup + Storybook. Каждая волна независима и verifiable.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Border removal (D-01, D-02) | Frontend (React CSS) | — | Inline style / className changes в TabNavigation, ServerSidebar |
| Sidebar show/hide (D-08) | Frontend (App.tsx) | ServerSidebar.tsx | Условный рендер / ширина управляется в App.tsx |
| Sidebar animation (D-11) | Frontend (CSS transition) | — | CSS `width + opacity` transition на wrapper |
| Tab roving focus (D-06) | Frontend (TabNavigation.tsx) | — | onKeyDown на `role="tablist"` |
| Tab max-width (D-05) | Frontend (TabNavigation.tsx) | — | CSS `max-width: 640px; margin: 0 auto` на `<nav>` |
| ServerTabs state cache (D-13, D-14) | Frontend (ServerTabs.tsx) | — | Замена `{cond && <C/>}` на `display:none` |
| Button variants fix (D-12) | Frontend (server/*.tsx) | — | Замена `variant="secondary"` → `variant="ghost"` в 7+ секциях |
| Disconnect a11y (D-19) | Frontend (ServerSidebar.tsx) | — | `group-focus-within:opacity-100` |
| Auth buttons color (D-15) | Frontend (CSS/tokens) | — | Найти компоненты с белым bg primary action |
| i18n hardcoded strings (D-17) | Frontend (Select/StatusBadge/EmptyState) | — | `useTranslation()` + t() |
| Sanitize fix (D-18) | Rust backend (logging.rs) | — | `pub fn sanitize()` в src-tauri/src/logging.rs |
| Sidebar bg token (D-16) | Frontend (ServerSidebar.tsx) | tokens.css | `--color-bg-secondary` |

---

## Standard Stack

### Core (уже установлен, не требует изменений)

| Библиотека | Версия | Назначение | Статус |
|-----------|--------|-----------|--------|
| React | 19 | UI framework | В проекте |
| Tailwind CSS | v3 | Utility classes + layout | В проекте |
| class-variance-authority (CVA) | последняя | Button/Badge variants | В проекте |
| react-i18next | последняя | Локализация через `t()` | В проекте |
| lucide-react | последняя | Иконки | В проекте |

[VERIFIED: grep по gui-app/src/]

### Established Patterns (использовать строго)

| Паттерн | Описание |
|---------|---------|
| CSS display:none toggle | `style={{ display: active ? "flex" : "none" }}` — для caching tab state |
| Inline style для token vars | `style={{ backgroundColor: "var(--color-bg-secondary)" }}` — не Tailwind arbitrary |
| CVA variants | Только: `primary`, `danger`, `ghost`, `icon` (Button); `success`, `warning`, `danger`, `neutral`, `dot` (Badge) |
| `useTranslation()` + `t()` | Все UI-строки через хук, дефолты в ru.json / en.json |
| `role="tablist"` + `role="tab"` | Уже есть в TabNavigation. Расширить: `tabIndex`, `onKeyDown` |

[VERIFIED: прямое чтение исходных файлов]

---

## Architecture Patterns

### System Architecture Diagram

```
App.tsx
├── TitleBar (32px, не меняется D-07)
├── Content Area
│   ├── [D-08] ServerSidebar ──shown only when servers.length >= 2──►
│   │     CSS: width/opacity transition (D-11)
│   │     Remove: border-r, border-b header, border-t footer (D-01)
│   │     Add: bg-color-bg-secondary
│   │     Remove: status dots (D-09)
│   │     Fix: group-focus-within disconnect (D-19)
│   └── Panel Area (display:none toggle)
│         ├── ControlPanelPage
│         │   └── ServerTabs [D-13/D-14 fix: display:none instead of && render]
│         ├── SettingsPanel
│         ├── RoutingPanel
│         └── ...
└── TabNavigation (56px)
      Remove: borderTop (D-01)
      Add: max-width: 640px (D-05)
      Add: roving focus ArrowLeft/ArrowRight (D-06)
```

```
shared/ui/ design-system cleanup
├── Select.tsx            [D-17] placeholder = "Выберите..." → t("select.placeholder")
├── StatusBadge.tsx       [D-17] defaultLabels hardcoded → t("status.*")
├── EmptyState.tsx        [D-17] default "Ничего нет" → через props (caller передаёт t())
└── server/*.tsx          [D-12] variant="secondary" → "ghost", "success" → "primary"
```

```
Rust backend
└── logging.rs            [D-18] sanitize() — верифицировать: already loop-based,
                                tests exist for multi-occurrence
```

### Recommended Project Structure (без изменений)

```
gui-app/src/
├── components/
│   ├── layout/
│   │   ├── TabNavigation.tsx   ← D-01, D-05, D-06
│   │   ├── TitleBar.tsx        ← не меняется
│   │   └── WindowControls.tsx  ← не меняется
│   ├── ServerSidebar.tsx       ← D-01, D-03, D-08, D-09, D-11, D-16, D-19
│   ├── ServerTabs.tsx          ← D-13, D-14
│   └── server/
│       ├── *Section.tsx        ← D-12 (Button variants fix)
│       └── ServerStatusSection.tsx  ← D-15 (auth buttons)
├── shared/ui/
│   ├── Select.tsx              ← D-17
│   ├── StatusBadge.tsx         ← D-17
│   └── EmptyState.tsx          ← D-17
├── i18n/locales/
│   ├── ru.json                 ← новые ключи: select.placeholder
│   └── en.json                 ← то же
└── App.tsx                     ← D-08 условный рендер sidebar
```

### Pattern 1: CSS display:none для state preservation

**Что:** Замена `{condition && <Component />}` на `style={{ display: condition ? "block" : "none" }}`
**Когда:** ServerTabs — когда нужно сохранить state компонента без unmount

```tsx
// Source: App.tsx (уже используется для главных табов — паттерн проверен)
// Применить в ServerTabs.tsx:

// БЫЛО (unmount на каждом переключении):
{activeTab === "status" && <ServerStatusSection state={state} />}
{activeTab === "users" && <UsersSection state={state} />}

// СТАЛО (mount once, display:none toggle):
<div style={{ display: activeTab === "status" ? "block" : "none" }}>
  <ServerStatusSection state={state} />
</div>
<div style={{ display: activeTab === "users" ? "block" : "none" }}>
  <UsersSection state={state} />
</div>
```

[VERIFIED: App.tsx строки 355–431 — паттерн уже применён для AppTab]

### Pattern 2: WAI-ARIA Roving Focus (tablist)

**Что:** ArrowLeft/ArrowRight перемещают фокус между табами, не вызывая переключение.
**Когда:** `role="tablist"` с 2+ табами — WAI-ARIA Authoring Practices 3.1

```tsx
// Source: [CITED: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/]
// Применить в TabNavigation.tsx

<nav
  role="tablist"
  onKeyDown={(e) => {
    const tabEls = navRef.current?.querySelectorAll('[role="tab"]');
    if (!tabEls) return;
    const currentIdx = TABS.findIndex(t => t.id === activeTab);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = (currentIdx + 1) % TABS.length;
      (tabEls[next] as HTMLElement).focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = (currentIdx - 1 + TABS.length) % TABS.length;
      (tabEls[prev] as HTMLElement).focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      (tabEls[0] as HTMLElement).focus();
    } else if (e.key === "End") {
      e.preventDefault();
      (tabEls[tabEls.length - 1] as HTMLElement).focus();
    }
  }}
>
  {TABS.map((tab) => {
    const active = activeTab === tab.id;
    return (
      <button
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}   // ← ключевое: только активный в tab order
        onClick={() => onTabChange(tab.id)}
        ...
      />
    );
  })}
</nav>
```

**Примечание:** Focus-only навигация (ArrowKey) — НЕ переключает таб, только перемещает фокус. Click/Enter/Space — переключает.

### Pattern 3: Sidebar Show/Hide Animation

**Что:** CSS transition на `width` + `opacity` при изменении `servers.length >= 2`
**Когда:** Пользователь добавляет/удаляет сервер — sidebar появляется/исчезает

```tsx
// Source: UI-SPEC.md §Motion Contract + tokens.css (строки 104-107, 257-258)
// Применить в App.tsx / ControlPanelPage.tsx wrapper

const sidebarVisible = servers.length >= 2;

<div
  style={{
    width: sidebarVisible ? 220 : 0,
    opacity: sidebarVisible ? 1 : 0,
    overflow: "hidden",
    transition: `width ${sidebarVisible ? "var(--transition-normal)" : "var(--transition-fast)"} var(--ease-out), opacity ${sidebarVisible ? "var(--transition-normal)" : "var(--transition-fast)"} var(--ease-out)`,
    // prefers-reduced-motion: автоматически обнуляется через tokens.css media query
  }}
>
  <ServerSidebar ... />
</div>
```

**Asymmetric timing:** появление 200ms (`--transition-normal`), исчезновение 150ms (`--transition-fast`). [VERIFIED: tokens.css строки 104, 105, 107]

### Pattern 4: i18n для компонент с дефолтными строками

```tsx
// Source: [VERIFIED: existing codebase pattern]

// Select.tsx — НЕ использовать useTranslation напрямую (форвард-рефф)
// Вариант: caller передаёт t("select.placeholder") как placeholder prop
// или добавить useTranslation() внутри Select

// StatusBadge.tsx — добавить useTranslation(), заменить defaultLabels:
const { t } = useTranslation();
const defaultLabels = {
  connected: t("status.connected"),
  connecting: t("status.connecting"),
  error: t("status.error"),
  disconnected: t("status.disconnected"),
};

// EmptyState.tsx — убрать дефолтные RU строки:
// БЫЛО: heading = "Ничего нет"
// СТАЛО: heading?: string  (undefined by default, caller обязан передать)
// Все вызовы EmptyState в коде уже передают heading через props или t()
```

[VERIFIED: Select.tsx строка 33; StatusBadge.tsx defaultLabels; EmptyState.tsx строки 14-15]

### Anti-Patterns to Avoid

- **`{condition && <Component />}` для stateful компонентов:** вызывает unmount/remount — использовать display:none
- **`variant="secondary"` на Button:** не существует в CVA, TypeScript ошибка — использовать `"ghost"`
- **`variant="success"` на Button:** не существует — использовать `"primary"`
- **`variant="default"` на Badge:** не существует — использовать `"neutral"`
- **`variant="accent"` на Badge:** не существует — использовать `"neutral"` или inline style
- **Hardcoded RU string как default prop:** нарушает i18n — использовать undefined + t() на вызывающей стороне
- **Tailwind arbitrary `hover:bg-[var(--token)]/50` в inline-style стиле:** предпочесть `style={{ ... }}` объекты

---

## Don't Hand-Roll

| Проблема | Не строить | Использовать | Почему |
|---------|------------|--------------|--------|
| Tab state preservation | Кастомный cache hook | CSS `display:none` | Уже есть в App.tsx, проверен |
| Roving focus | Radix NavigationMenu | onKeyDown + tabIndex=-1 | shadcn/Radix исключены в REQUIREMENTS.md |
| Sidebar transition | JS-based animation | CSS `transition: width/opacity` | Нативный CSS, поддерживает prefers-reduced-motion автоматически |
| i18n defaults | Дублирование строк | `t()` с ru.json/en.json | Инфраструктура существует |
| Sanitize multi-occurrence | String.replace(g) JS | Rust loop в logging.rs | Rust функция уже существует и имеет тесты |

---

## Common Pitfalls

### Pitfall 1: ServerTabs — неправильный display:none

**Что идёт не так:** Обёртка `<div style="display:none">` вокруг секций может нарушить layout если секции используют `scroll-overlay` или `flex flex-col`. Нужна обёртка `h-full flex flex-col overflow-hidden`.

**Как избежать:** Использовать `<div className="h-full flex flex-col overflow-hidden" style={{ display: ... }}>` — тот же паттерн что в App.tsx строки 355-431.

**Признаки проблемы:** Контент секций не занимает всю высоту, scroll не работает.

### Pitfall 2: Sidebar animation — layout shift из-за margin/padding

**Что идёт не так:** При `width: 0` padding/margin sidebar может ломать layout если не скрыт через `overflow: hidden`.

**Как избежать:** `overflow: hidden` на wrapper — обязательно. Убедиться, что ширина 0 полностью скрывает sidebar.

**Признаки:** Sidebar кнопки видны на `width: 0` на некоторых браузерах.

### Pitfall 3: i18n — EmptyState без дефолтов

**Что идёт не так:** Если убрать дефолтные строки из EmptyState, все существующие вызовы без heading prop покажут `undefined`.

**Как избежать:** Перед удалением дефолтов — проверить ВСЕ вызовы EmptyState в codebase. Если caller уже передаёт t() — безопасно. Альтернатива: оставить дефолт как `t("empty.default_heading")`.

**Признаки:** Пустые heading в тестовых сценариях.

### Pitfall 4: sanitize() — статус уже исправлен?

**Что идёт не так:** Задача D-18 (sanitize fix) может быть уже сделана. Функция в logging.rs строки 30-59 использует `loop` + `search_from` — это multi-occurrence паттерн. Тесты `sanitize_replaces_all_occurrences` на строке 280 проверяют именно это.

**Как избежать:** ПЕРЕД включением D-18 в план — запустить тест `cargo test sanitize` и убедиться что он проходит. Если проходит — задача уже закрыта, D-18 помечается как DONE.

**Признаки:** `cargo test -- sanitize_replaces_all_occurrences` проходит.

### Pitfall 5: Button variant="success" vs Badge variant="success"

**Что идёт не так:** Badge имеет `success` вариант. Button — нет. Путаница приводит к неверным заменам.

**Как избежать:**
- `<Button variant="success">` → `<Button variant="primary">`
- `<Badge variant="success">` → ОСТАВИТЬ (корректный вариант Badge)
- `<Badge variant="default">` → `<Badge variant="neutral">`
- `<Badge variant="accent">` → `<Badge variant="neutral">` (accent не существует)

[VERIFIED: Button.tsx строки 17-40; Badge.tsx строки 15-44]

### Pitfall 6: ServerSidebar — статус dots уже используют токены

**Что идёт не так:** TODO `sidebar-hardcoded-colors` упоминает `bg-emerald-400`. Но текущий код в ServerSidebar.tsx (строки 23-28) **уже использует** `statusDotStyle` с `var(--color-status-*)`. Задача D-16 для dots уже выполнена в Phase 4.

**Как избежать:** D-16 сфокусировать только на Tailwind arbitrary classes в hover/selected states (`hover:bg-[var(--color-bg-elevated)]/50`), а не на status dots.

[VERIFIED: ServerSidebar.tsx строки 22-28]

---

## Code Examples

### Удаление borderTop из TabNavigation

```tsx
// Source: TabNavigation.tsx строка 38-39 (УДАЛИТЬ)
// БЫЛО:
style={{
  height: 56,
  borderTop: "1px solid var(--color-border)",  // ← УДАЛИТЬ
}}

// СТАЛО:
style={{ height: 56 }}
```

### Удаление border-r из ServerSidebar

```tsx
// Source: ServerSidebar.tsx строка 34 (ИЗМЕНИТЬ)
// БЫЛО:
<div className="w-[200px] shrink-0 flex flex-col border-r border-[var(--color-border)]">

// СТАЛО:
<div
  className="w-[220px] shrink-0 flex flex-col"
  style={{ backgroundColor: "var(--color-bg-secondary)" }}
>
```

### Добавление group-focus-within для disconnect a11y

```tsx
// Source: ServerSidebar.tsx строка 80 (ИЗМЕНИТЬ)
// БЫЛО:
className="opacity-0 group-hover:opacity-100 p-0.5 rounded ..."

// СТАЛО:
className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 rounded ..."
```

### StatusBadge i18n fix

```tsx
// Source: StatusBadge.tsx строки 27-32 (ИЗМЕНИТЬ)
// БЫЛО (hardcoded):
const defaultLabels = {
  connected: "Подключено",
  ...
};

// СТАЛО:
export function StatusBadge({ variant = "disconnected", label, className }: StatusBadgeProps) {
  const { t } = useTranslation();
  const resolvedVariant = (variant ?? "disconnected") as NonNullable<typeof variant>;
  const defaultLabel = label ?? t(`status.${resolvedVariant}`, resolvedVariant);
  // t("status.connected") → "Подключен" (ru) / "Connected" (en) — ключи уже есть в locales
  ...
}
```

[VERIFIED: ru.json имеет status.connected, status.connecting, status.error, status.disconnected]

### Select placeholder i18n

```tsx
// Source: Select.tsx строка 33 (ИЗМЕНИТЬ)
// БЫЛО:
placeholder = "Выберите...",

// СТАЛО — добавить i18n ключ в ru.json и en.json:
// ru.json: "select": { "placeholder": "Выберите..." }
// en.json: "select": { "placeholder": "Select..." }
// Select.tsx: useTranslation() внутри forwardRef компонента
// placeholder по умолчанию: t("select.placeholder", "Выберите...")
```

[VERIFIED: ru.json строка "select": {} — пустой объект, ключ нужно добавить]

---

## Pre-Task Verification Checklist

> Эти проверки должны быть включены в Wave 0 каждого плана.

1. **D-18 Sanitize fix:** запустить `cargo test sanitize_replaces_all_occurrences` в `gui-app/src-tauri/` — если PASS, задача уже выполнена.
2. **D-16 Sidebar tokens:** подтвердить что `hover:bg-[var(--color-bg-elevated)]/50` в строке 55 ServerSidebar.tsx — единственный hardcoded arbitrary цвет (status dots уже исправлены).
3. **D-12 Button variants:** запустить `npx tsc --noEmit` в `gui-app/` — TypeScript покажет все невалидные variants.
4. **D-13/D-14 Tab state:** убедиться что все рендеры в ServerTabs.tsx (строки 72-89) используют `{activeTab === X && <C/>}` — подтвердить проблему перед фиксом.

---

## Storybook Requirements

Каждый изменённый компонент должен иметь актуальную story:

| Компонент | Существует | Что обновить |
|-----------|-----------|-------------|
| TabNavigation | `TabNavigation.stories.tsx` | Добавить: wide-window viewport story (1200px), roving focus demo |
| ServerSidebar | `ServerSidebar.stories.tsx` | Обновить: убрать status dots из stories; добавить single-server hidden story |
| AppShell | `AppShell.stories.tsx` | Обновить: убрать `borderTop: "1px solid..."` из ContentPlaceholder (строка 25) |

[VERIFIED: прямое чтение stories файлов]

---

## State of the Art

| Старый подход | Текущий подход | Когда изменился | Влияние |
|--------------|-----------------|----------------|---------|
| `{cond && <C/>}` для статeful вкладок | `display:none` CSS toggle | Phase 4 (App.tsx) | Нет unmount = нет потери state |
| `border-bottom` underline tab | Elevated pill (bg-elevated 120x44px) | Phase 4 | Более современный вид |
| Hardcoded `bg-emerald-400` в sidebar | `var(--color-status-connected)` token | Phase 4 | Уже исправлено |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | sanitize() в logging.rs уже исправлен (loop-based multi-occurrence) | Common Pitfall 4 | D-18 требует дополнительной работы |
| A2 | ServerSidebar.stories.tsx не нужно полностью переписывать, только обновить | Storybook | Больше работы чем ожидается |
| A3 | Auth buttons color проблема (D-15) — только в ServerPanel/ControlPanel, не в других местах | Code Examples | Потребуется дополнительный grep |

**Все три требуют верификации в Wave 0 плана.**

---

## Open Questions (RESOLVED)

1. **D-18 Sanitize — уже исправлен?** — RESOLVED
   - Что знаем: logging.rs строки 40-54 используют loop + search_from, тест строка 280 проверяет multi-occurrence
   - Решение: Plan 05-03 Task 2 выполняет `cargo test` верификацию. Если тест проходит — fix уже выполнен, задача завершается подтверждением.

2. **D-15 Auth buttons — где именно?** — RESOLVED
   - Что знаем: кнопки auth (Пароль / SSH-ключ) слишком белые на light theme
   - Решение: Plan 05-02 Task 2 адресует auth buttons через grep по SshConnectForm и ToggleGroup компонентам.

3. **D-08 Sidebar hidden — ServerSidebar рендерить или нет?** — RESOLVED
   - Что знаем: при `servers.length < 2` sidebar должен быть скрыт
   - Решение: CSS transition approach (`width:0 overflow:hidden`) — элемент остаётся mounted для анимации. Plan 05-01 Task 3 реализует это.

---

## Environment Availability

Step 2.6: ПРОВЕРЕНО

| Dependency | Required By | Available | Version |
|------------|------------|-----------|---------|
| Node.js / npm | Frontend build | ✓ | в проекте |
| cargo | D-18 Rust fix + tests | ✓ | `~/.cargo/bin/cargo` |
| vitest | Frontend tests | ✓ | package.json test scripts |
| TypeScript | D-12 variant check | ✓ | `npx tsc --noEmit` |

[VERIFIED: bash `command -v cargo` → `/c/Users/naska/.cargo/bin/cargo`]

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest + jsdom (frontend); cargo test (Rust) |
| Config file | `gui-app/vite.config.ts` (строки test:{ globals: true, environment: "jsdom" }) |
| Quick run | `cd gui-app && npx vitest run src/components/layout/` |
| Full suite | `cd gui-app && npx vitest run` |
| Rust tests | `cd gui-app/src-tauri && cargo test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SCR-10 | Sidebar скрыт при 1 сервере | unit | `npx vitest run src/components/ServerSidebar` | ❌ Wave 0 |
| SCR-10 | Tab roving focus ArrowKey | unit | `npx vitest run src/components/layout/TabNavigation` | ✅ (expand) |
| SCR-10 | Border removal (no border tokens) | visual | Storybook + ручная проверка | — |
| SCR-11 | WindowControls — не меняется, уже работает | — | TitleBar.test.tsx уже есть | ✅ |
| D-12 | Button variants TypeScript | type-check | `npx tsc --noEmit` в gui-app/ | ✅ |
| D-13/D-14 | ServerTabs state preserved | unit | новый test — ServerTabs.test.tsx | ❌ Wave 0 |
| D-18 | sanitize() multi-occurrence | unit (Rust) | `cargo test -- sanitize_replaces_all_occurrences` | ✅ (уже есть) |
| D-17 | i18n keys exist | unit | проверить что t("status.connected") ≠ key | ✅ (ключи в locales) |

### Wave 0 Gaps

- [ ] `gui-app/src/components/ServerSidebar.test.tsx` — тест `servers.length < 2 → sidebar hidden`
- [ ] `gui-app/src/components/ServerTabs.test.tsx` — тест state preservation при переключении табов

### Sampling Rate

- **Per task commit:** `npx vitest run src/components/layout/ && npx tsc --noEmit`
- **Per wave merge:** `npx vitest run && cargo test`
- **Phase gate:** full suite green + Storybook visual check

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | partial | D-18: sanitize() маскирует sensitive keys в logs |
| V6 Cryptography | no | — |

### Known Threat Patterns

| Pattern | STRIDE | Mitigation |
|---------|--------|------------|
| Sensitive data in logs (password/certificate) | Information Disclosure | sanitize() в logging.rs — маскирует все вхождения |
| Keyboard-only users cannot trigger disconnect | — | D-19: `group-focus-within:opacity-100` |

**D-18 security note:** sanitize() защищает log files от утечки паролей/сертификатов. Это security fix, не только cleanup — должен быть в плане если тест НЕ проходит.

---

## Sources

### Primary (HIGH confidence)
- `gui-app/src/components/layout/TabNavigation.tsx` — полное чтение
- `gui-app/src/components/ServerSidebar.tsx` — полное чтение
- `gui-app/src/App.tsx` — полное чтение
- `gui-app/src-tauri/src/logging.rs` — строки 1-60, 260-320
- `gui-app/src/shared/ui/Button.tsx` — CVA variants
- `gui-app/src/shared/ui/Badge.tsx` — CVA variants
- `gui-app/src/shared/ui/StatusBadge.tsx` — defaultLabels
- `gui-app/src/shared/ui/Select.tsx` — hardcoded placeholder
- `gui-app/src/shared/ui/EmptyState.tsx` — hardcoded defaults
- `gui-app/src/shared/i18n/locales/ru.json` — existing keys
- `gui-app/src/shared/i18n/locales/en.json` — existing keys
- `gui-app/src/shared/styles/tokens.css` — transition + sidebar tokens
- `gui-app/src/components/ServerTabs.tsx` — conditional render bug
- `.planning/phases/05-layout-shell/05-CONTEXT.md` — locked decisions D-01..D-19
- `.planning/phases/05-layout-shell/05-UI-SPEC.md` — interaction + motion contracts

### Secondary (MEDIUM confidence)
- WAI-ARIA Authoring Practices — tablist roving focus [CITED: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/]
- Emil Kowalski skill (`.agents/skills/emil-design-eng/SKILL.md`) — animation frequency heuristics

---

## Project Constraints (from CLAUDE.md)

CLAUDE.md не найден в рабочей директории.

Governance из STATE.md:
- Работать в `release/tt-win-3.0.0`, master READ-ONLY
- Storybook поддерживать актуальным после каждой фазы
- NSIS инсталляторы на рабочий стол после визуальных изменений
- Никаких AI/Claude артефактов в git (только код программы)

---

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — весь стек верифицирован прямым чтением исходников
- Architecture: HIGH — паттерны взяты из существующего кода (App.tsx уже использует display:none)
- Pitfalls: HIGH — все pitfalls основаны на реальном коде (Badge variants, existing sanitize tests)
- Sanitize status: MEDIUM — логика multi-occurrence выглядит исправленной, но тест не запускался

**Research date:** 2026-04-15
**Valid until:** 2026-05-15 (стабильная кодовая база, без внешних зависимостей)
