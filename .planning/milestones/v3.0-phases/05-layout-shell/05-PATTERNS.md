# Phase 5: Shell Polish + TODO Closure - Pattern Map

**Mapped:** 2026-04-15
**Files analyzed:** 14 (modified) + 2 (locales)
**Analogs found:** 14 / 14

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `gui-app/src/components/layout/TabNavigation.tsx` | component | request-response | self (modify in place) | self |
| `gui-app/src/components/layout/TitleBar.tsx` | component | — | self (no-op per D-07) | self |
| `gui-app/src/components/layout/WindowControls.tsx` | component | — | self (no-op per D-07) | self |
| `gui-app/src/components/ServerSidebar.tsx` | component | event-driven | self (modify in place) | self |
| `gui-app/src/App.tsx` | component | event-driven | self (modify in place) | self |
| `gui-app/src/components/ServerTabs.tsx` | component | request-response | `App.tsx` lines 355–431 | exact (display:none pattern) |
| `gui-app/src/index.css` | config | — | self (no-op, confirmed stable) | self |
| `gui-app/src/components/server/Fail2banSection.tsx` | component | CRUD | `Button.tsx` (CVA variants) | exact |
| `gui-app/src/components/server/CertSection.tsx` | component | CRUD | `Badge.tsx` (CVA variants) | exact |
| `gui-app/src/components/server/ServerStatusSection.tsx` | component | CRUD | `Button.tsx` + `Badge.tsx` | exact |
| `gui-app/src/components/server/DiagnosticsSection.tsx` | component | CRUD | `Button.tsx` (CVA variants) | exact |
| `gui-app/src/components/server/LogsSection.tsx` | component | CRUD | `Button.tsx` (CVA variants) | exact |
| `gui-app/src/components/server/FirewallSection.tsx` | component | CRUD | `Button.tsx` (CVA variants) | exact |
| `gui-app/src/components/server/UsersSection.tsx` | component | CRUD | `Button.tsx` (CVA variants) | exact |
| `gui-app/src/components/server/VersionSection.tsx` | component | CRUD | `Badge.tsx` (CVA variants) | exact |
| `gui-app/src/shared/ui/Select.tsx` | ui | request-response | `StatusBadge.tsx` (i18n pattern) | role-match |
| `gui-app/src/shared/ui/StatusBadge.tsx` | ui | request-response | `ServerSidebar.tsx` (useTranslation) | exact |
| `gui-app/src/shared/ui/EmptyState.tsx` | ui | request-response | `App.tsx` (EmptyState caller pattern) | role-match |
| `gui-app/src/shared/i18n/locales/ru.json` | config | — | self (extend existing keys) | self |
| `gui-app/src/shared/i18n/locales/en.json` | config | — | self (extend existing keys) | self |
| `gui-app/src-tauri/src/logging.rs` | utility | transform | self (verify-only, D-18) | self |

---

## Pattern Assignments

### `gui-app/src/components/layout/TabNavigation.tsx` (component, request-response)

**Analog:** self — modify in place

**Current state** (lines 33–40): border to remove:
```tsx
<nav
  role="tablist"
  className="flex items-center shrink-0"
  style={{
    height: 56,
    borderTop: "1px solid var(--color-border)",  // D-01: DELETE this line
  }}
>
```

**Fix D-01 — border removal:** delete `borderTop` line, keep `style={{ height: 56 }}`.

**Fix D-05 — tab max-width on wide windows:**
```tsx
// Wrap nav contents with a centered max-width container
<nav
  role="tablist"
  className="flex items-center justify-center shrink-0"
  style={{ height: 56 }}
>
  <div
    className="flex items-center w-full"
    style={{ maxWidth: 640 }}
  >
    {TABS.map(...)}
  </div>
</nav>
```

**Fix D-06 — roving focus (WAI-ARIA tablist):**
```tsx
// Add useRef + onKeyDown to nav element
import { useRef } from "react";

const navRef = useRef<HTMLElement>(null);

<nav
  ref={navRef}
  role="tablist"
  onKeyDown={(e) => {
    const tabEls = navRef.current?.querySelectorAll('[role="tab"]');
    if (!tabEls) return;
    const currentIdx = TABS.findIndex(t => t.id === activeTab);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      (tabEls[(currentIdx + 1) % TABS.length] as HTMLElement).focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      (tabEls[(currentIdx - 1 + TABS.length) % TABS.length] as HTMLElement).focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      (tabEls[0] as HTMLElement).focus();
    } else if (e.key === "End") {
      e.preventDefault();
      (tabEls[tabEls.length - 1] as HTMLElement).focus();
    }
  }}
  ...
>

// On each <button role="tab">: add tabIndex roving
<button
  role="tab"
  aria-selected={active}
  tabIndex={active ? 0 : -1}   // key: only active tab in tab order
  onClick={() => onTabChange(tab.id)}
  ...
/>
```

**Source proof:** TabNavigation.tsx already has `role="tablist"` (line 34), `role="tab"` (line 48), `aria-selected` (line 49). Extension of existing pattern only.

---

### `gui-app/src/components/ServerSidebar.tsx` (component, event-driven)

**Analog:** self — modify in place

**Fix D-01 — remove border-r (line 34):**
```tsx
// БЫЛО:
<div className="w-[200px] shrink-0 flex flex-col border-r border-[var(--color-border)]">

// СТАЛО (D-03 discretion: bg-secondary для визуального разделения без бордера):
<div
  className="w-[220px] shrink-0 flex flex-col"
  style={{ backgroundColor: "var(--color-bg-secondary)" }}
>
```

**Fix D-01 — remove border-b header (line 36):**
```tsx
// БЫЛО:
<div className="h-[40px] flex items-center px-3 border-b border-[var(--color-border)]">

// СТАЛО:
<div className="h-[40px] flex items-center px-3">
```

**Fix D-01 — remove border-t footer (line 105):**
```tsx
// БЫЛО:
<div className="p-2 border-t border-[var(--color-border)]">

// СТАЛО:
<div className="p-2">
```

**Fix D-09 — remove status dots (lines 59–62):** delete entire status dot `<div>` block:
```tsx
// DELETE:
<div
  className={cn("w-2 h-2 rounded-full shrink-0", srv.status === "connecting" && "animate-pulse")}
  style={statusDotStyle[srv.status]}
/>
// DELETE statusDotStyle constant (lines 23–28) as well
```

**Fix D-16 — Tailwind arbitrary hover class (line 55):**
```tsx
// БЫЛО:
"text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)]/50"

// СТАЛО (нет /50 Tailwind arbitrary — используем токен напрямую или bg-hover):
"text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
```

**Fix D-19 — disconnect button a11y (line 80):**
```tsx
// БЫЛО:
className="opacity-0 group-hover:opacity-100 p-0.5 rounded ..."

// СТАЛО:
className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 rounded ..."
```

**D-08/D-11 — sidebar show/hide:** управляется из App.tsx (см. ниже). ServerSidebar рендерится всегда, но обёртка меняет width/opacity через CSS transition.

---

### `gui-app/src/App.tsx` (component, event-driven)

**Analog:** self — modify in place

**Display:none pattern (lines 355–431)** — уже применён для AppTab, копировать точно этот же паттерн для sidebar wrapper:
```tsx
// Существующий паттерн (lines 355–431) — ЭТАЛОН для ServerTabs:
<div className="h-full flex flex-col overflow-hidden" style={{ display: activeTab === "control" ? "flex" : "none" }}>
  <PanelErrorBoundary ...>
    <ControlPanelPage ... />
  </PanelErrorBoundary>
</div>
```

**D-08/D-11 — sidebar animation wrapper:**
```tsx
// Добавить в content area (внутри flex row):
const sidebarVisible = servers.length >= 2;

<div
  style={{
    width: sidebarVisible ? 220 : 0,
    opacity: sidebarVisible ? 1 : 0,
    overflow: "hidden",
    flexShrink: 0,
    transition: `width ${sidebarVisible ? "var(--transition-normal)" : "var(--transition-fast)"} var(--ease-out), opacity ${sidebarVisible ? "var(--transition-normal)" : "var(--transition-fast)"} var(--ease-out)`,
  }}
>
  <ServerSidebar ... />
</div>
```

**Источник tokens:** `var(--transition-normal)` и `var(--transition-fast)` — из tokens.css. `var(--ease-out)` — из tokens.css. Prefers-reduced-motion обнуляется автоматически через media query в tokens.css.

---

### `gui-app/src/components/ServerTabs.tsx` (component, request-response)

**Analog:** `gui-app/src/App.tsx` lines 355–431 (display:none tab pattern)

**Fix D-13/D-14 — tab state preservation (lines 70–93):**
```tsx
// БЫЛО (unmount/remount на каждом switch):
<div className="flex-1 scroll-overlay py-3 px-4 space-y-4">
  {activeTab === "status" && <ServerStatusSection state={state} />}
  {activeTab === "users" && <UsersSection state={state} />}
  {activeTab === "config" && (
    <>
      <VersionSection state={state} />
      <ConfigSection state={state} />
    </>
  )}
  ...
</div>

// СТАЛО (mount once, display:none toggle — паттерн из App.tsx):
<div className="flex-1 min-h-0 overflow-hidden">
  <div className="h-full flex flex-col overflow-hidden scroll-overlay py-3 px-4 space-y-4"
       style={{ display: activeTab === "status" ? "flex" : "none" }}>
    <ServerStatusSection state={state} />
  </div>
  <div className="h-full flex flex-col overflow-hidden scroll-overlay py-3 px-4 space-y-4"
       style={{ display: activeTab === "users" ? "flex" : "none" }}>
    <UsersSection state={state} />
  </div>
  <div className="h-full flex flex-col overflow-hidden scroll-overlay py-3 px-4 space-y-4"
       style={{ display: activeTab === "config" ? "flex" : "none" }}>
    <VersionSection state={state} />
    <ConfigSection state={state} />
  </div>
  <div className="h-full flex flex-col overflow-hidden scroll-overlay py-3 px-4 space-y-4"
       style={{ display: activeTab === "security" ? "flex" : "none" }}>
    <SecuritySection state={state} />
    <CertSection state={state} />
  </div>
  <div className="h-full flex flex-col overflow-hidden scroll-overlay py-3 px-4 space-y-4"
       style={{ display: activeTab === "tools" ? "flex" : "none" }}>
    <UtilitiesSection state={state} />
    <LogsSection state={state} />
  </div>
  <div className="h-full flex flex-col overflow-hidden scroll-overlay py-3 px-4 space-y-4"
       style={{ display: activeTab === "danger" ? "flex" : "none" }}>
    <DangerZoneSection state={state} />
  </div>
</div>
```

**Pitfall:** обёртка секций должна иметь `h-full flex flex-col overflow-hidden` иначе scroll сломается (Pitfall 1 из RESEARCH.md).

---

### `gui-app/src/components/server/*Section.tsx` — Button/Badge variant fixes (D-12)

**Analog:** `gui-app/src/shared/ui/Button.tsx` (valid variants) + `gui-app/src/shared/ui/Badge.tsx` (valid variants)

**Валидные варианты Button** (Button.tsx lines 17–46):
- `primary` — синий акцент, белый текст
- `danger` — красный, белый текст
- `ghost` — прозрачный, вторичный текст
- `icon` — прозрачный, muted иконка
- НЕ существует: `secondary`, `success`, `danger-outline`

**Валидные варианты Badge** (Badge.tsx lines 16–47):
- `success`, `warning`, `danger`, `neutral`, `dot`
- НЕ существует: `default`, `accent`

**Таблица замен:**

| Файл | Строка | Было | Стало | Компонент |
|------|--------|------|-------|-----------|
| `Fail2banSection.tsx` | 42 | `variant="secondary"` | `variant="ghost"` | Button |
| `Fail2banSection.tsx` | 110 | `variant="secondary"` | `variant="ghost"` | Button |
| `CertSection.tsx` | 193 | `variant="success"` | `variant="success"` | **Badge — ОСТАВИТЬ** |
| `CertSection.tsx` | 197 | `variant="default"` | `variant="neutral"` | Badge |
| `CertSection.tsx` | 258 | `variant="secondary"` | `variant="ghost"` | Button |
| `ServerStatusSection.tsx` | 171 | `variant="default"` | `variant="neutral"` | Badge |
| `ServerStatusSection.tsx` | 183 | `variant="secondary"` | `variant="ghost"` | Button |
| `ServerStatusSection.tsx` | 207 | `variant="success"` | `variant="primary"` | Button |
| `DiagnosticsSection.tsx` | 57 | `variant="secondary"` | `variant="ghost"` | Button |
| `DiagnosticsSection.tsx` | 69 | `variant="secondary"` | `variant="ghost"` | Button |
| `LogsSection.tsx` | 85 | `variant="secondary"` | `variant="ghost"` | Button |
| `FirewallSection.tsx` | 51 | `variant="secondary"` | `variant="ghost"` | Button |
| `UsersSection.tsx` | 334 | `variant="success"` | `variant="primary"` | Button |
| `VersionSection.tsx` | 84 | `variant="accent"` | `variant="neutral"` | Badge |
| `VersionSection.tsx` | 86 | `variant="success"` | `variant="success"` | **Badge — ОСТАВИТЬ** |

**Критически важно (Pitfall 5 из RESEARCH.md):**
- `<Badge variant="success">` — КОРРЕКТНО, оставить
- `<Button variant="success">` → заменить на `<Button variant="primary">`
- `<Badge variant="default">` → заменить на `<Badge variant="neutral">`

---

### `gui-app/src/shared/ui/StatusBadge.tsx` (ui, request-response)

**Analog:** `gui-app/src/components/ServerSidebar.tsx` (useTranslation pattern, line 1, 31)

**Fix D-17 — i18n defaultLabels (lines 25–30):**
```tsx
// Добавить import:
import { useTranslation } from "react-i18next";

// БЫЛО (hardcoded RU):
const defaultLabels: Record<...> = {
  connected: "Подключено",
  connecting: "Подключение...",
  error: "Ошибка",
  disconnected: "Отключено",
};

export function StatusBadge({ variant = "disconnected", label, className }: StatusBadgeProps) {
  const resolvedVariant = (variant ?? "disconnected") as NonNullable<typeof variant>;
  const displayLabel = label ?? defaultLabels[resolvedVariant];

// СТАЛО (i18n):
// Удалить defaultLabels константу

export function StatusBadge({ variant = "disconnected", label, className }: StatusBadgeProps) {
  const { t } = useTranslation();
  const resolvedVariant = (variant ?? "disconnected") as NonNullable<typeof variant>;
  const displayLabel = label ?? t(`status.${resolvedVariant}`, resolvedVariant);
  // ru.json уже содержит: status.connected, status.connecting, status.error, status.disconnected
```

**Источник ключей:** `gui-app/src/shared/i18n/locales/ru.json` строки 17–30 — ключи `status.connected`, `status.connecting`, `status.error`, `status.disconnected` уже существуют.

---

### `gui-app/src/shared/ui/Select.tsx` (ui, request-response)

**Analog:** `gui-app/src/shared/ui/StatusBadge.tsx` (useTranslation pattern после фикса)

**Fix D-17 — placeholder i18n (line 33):**
```tsx
// Добавить import:
import { useTranslation } from "react-i18next";

// Select — forwardRef компонент. Добавить useTranslation внутри функции:
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    label,
    description,
    icon,
    options,
    value,
    onChange,
    placeholder,        // убрать default значение из деструктуризации
    fullWidth = true,
    disabled = false,
    className,
  },
  ref,
) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t("select.placeholder", "Выберите...");
  // далее использовать resolvedPlaceholder вместо placeholder
```

**Новые ключи** для `ru.json` и `en.json`:
```json
// ru.json — добавить:
"select": {
  "placeholder": "Выберите..."
}

// en.json — добавить:
"select": {
  "placeholder": "Select..."
}
```

**Важно:** `forwardRef` не мешает `useTranslation()` — хук вызывается внутри функции компонента, что допустимо.

---

### `gui-app/src/shared/ui/EmptyState.tsx` (ui, request-response)

**Analog:** `gui-app/src/App.tsx` (EmptyState caller, lines 390–396)

**Fix D-17 — убрать hardcoded RU defaults (lines 13–16):**
```tsx
// БЫЛО (hardcoded RU defaults):
export function EmptyState({
  icon,
  heading = "Ничего нет",
  body = "Здесь появятся элементы после добавления.",
  action,
  className,
}: EmptyStateProps) {

// СТАЛО (нет дефолтов, caller обязан передать):
export function EmptyState({
  icon,
  heading,
  body,
  action,
  className,
}: EmptyStateProps) {
```

**Проверка вызовов перед удалением дефолтов:**

| Вызов | Передаёт heading? | Безопасно? |
|-------|-------------------|-----------|
| `App.tsx` line 390 | `heading={i18n.t("connection.noConfig", ...)}` | Да |
| `ServerSidebar.tsx` line 97 | `heading={t("sidebar.no_servers", "Нет серверов")}` | Да |
| Другие (grep needed) | Нужно проверить | Верифицировать в Wave 0 |

**Альтернатива** если grep найдёт вызовы без heading: `heading = t("empty.default_heading", "Ничего нет")` — добавить новый ключ в locales.

---

### `gui-app/src/components/server/ServerStatusSection.tsx` — D-15 auth buttons

**Analog:** `gui-app/src/shared/ui/Button.tsx` primary variant (lines 19–25)

**D-15 проблема:** кнопки auth (connect/disconnect) слишком белые на light theme. Предположительно `variant="secondary"` (несуществующий) или inline white bg.

**Паттерн исправления:** использовать `variant="primary"` для активных actions, `variant="ghost"` для вторичных.

**Важно:** D-15 требует grep-верификации в Wave 0 (Open Question A3 из RESEARCH.md). Точные строки неизвестны.

---

### `gui-app/src-tauri/src/logging.rs` — D-18 sanitize verify

**Analog:** self

**Текущее состояние** (logging.rs lines 30–59): функция уже использует `loop` + `search_from` паттерн для multi-occurrence. Тест `sanitize_replaces_all_occurrences` должен существовать.

**Действие:** только верификация (`cargo test -p gui-app -- sanitize`). Если PASS — D-18 закрыть как DONE без изменений. Если FAIL — исправить.

---

## Shared Patterns

### Паттерн 1: CSS display:none для state preservation
**Источник:** `gui-app/src/App.tsx` lines 355–431
**Применить к:** `ServerTabs.tsx` (D-13, D-14)
```tsx
<div
  className="h-full flex flex-col overflow-hidden"
  style={{ display: activeTab === "X" ? "flex" : "none" }}
>
  <Component ... />
</div>
```

### Паттерн 2: Inline style для design token vars (не Tailwind arbitrary)
**Источник:** `gui-app/src/components/ServerSidebar.tsx` line 80, line 90
**Применить к:** всем изменениям в ServerSidebar, App.tsx sidebar wrapper
```tsx
// Правильно:
style={{ backgroundColor: "var(--color-bg-secondary)" }}

// Неправильно (Tailwind arbitrary с /50):
className="hover:bg-[var(--color-bg-elevated)]/50"
```

### Паттерн 3: useTranslation i18n
**Источник:** `gui-app/src/components/ServerSidebar.tsx` lines 1, 31
**Применить к:** Select.tsx, StatusBadge.tsx, EmptyState.tsx
```tsx
import { useTranslation } from "react-i18next";
// внутри компонента:
const { t } = useTranslation();
// использование:
t("key.name", "fallback string")
```

### Паттерн 4: CVA variant-only (Button)
**Источник:** `gui-app/src/shared/ui/Button.tsx` lines 17–46
**Применить к:** всем `<Button>` в server/*Section.tsx
- Допустимо: `primary`, `danger`, `ghost`, `icon`
- Недопустимо: `secondary`, `success`, `danger-outline`, `default`

### Паттерн 5: CVA variant-only (Badge)
**Источник:** `gui-app/src/shared/ui/Badge.tsx` lines 16–47
**Применить к:** всем `<Badge>` в server/*Section.tsx
- Допустимо: `success`, `warning`, `danger`, `neutral`, `dot`
- Недопустимо: `default`, `accent`

### Паттерн 6: CSS transition для sidebar animation
**Источник:** tokens.css (transition vars) + RESEARCH.md Pattern 3
**Применить к:** App.tsx sidebar wrapper (D-08, D-11)
```tsx
transition: `width var(--transition-normal) var(--ease-out), opacity var(--transition-normal) var(--ease-out)`
```
Asymmetric: появление `--transition-normal` (200ms), скрытие `--transition-fast` (150ms).

---

## No Analog Found

Все файлы имеют аналоги или являются self-modifications. Нет файлов без паттернов.

| Файл | Причина |
|------|---------|
| — | — |

---

## Wave 0 Pre-Checks (для планировщика)

Плановщик должен включить эти верификации как первый шаг плана:

1. **D-18 sanitize:** `cargo test -p gui-app -- sanitize_replaces_all_occurrences` → если PASS, закрыть D-18 без изменений
2. **D-15 auth buttons:** `grep -rn "SshConnectForm\|auth.*Button\|variant.*auth" gui-app/src/` → найти точные строки
3. **D-12 Button variants:** `npx tsc --noEmit` в `gui-app/` → TypeScript покажет все невалидные variants
4. **EmptyState callers:** `grep -rn "<EmptyState" gui-app/src/` → убедиться что все callers передают heading перед удалением дефолтов

---

## Metadata

**Analog search scope:** `gui-app/src/components/`, `gui-app/src/shared/ui/`, `gui-app/src-tauri/src/`
**Files scanned:** 21 (исходные файлы) + 2 (locales)
**Pattern extraction date:** 2026-04-15
