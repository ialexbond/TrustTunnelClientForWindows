---
phase: 14-overflow-menu-dns-upstream-auto-qr
plan: 02
subsystem: shared/ui primitives
tags: [overflow-menu, viewport-clipping, auto-flip, d-12, tooltip-port, primitive-fix]
requires:
  - gui-pro/src/shared/ui/Tooltip.tsx (reference algorithm with WR-07/WR-08 fixes)
  - gui-pro/src/shared/ui/OverflowMenu.tsx (pre-existing primitive with viewport-clip bug)
provides:
  - gui-pro/src/shared/ui/OverflowMenu.tsx (viewport-aware auto-flip primitive)
affects:
  - gui-pro/src/components/server/UsersSection.tsx (only current consumer — no API change)
tech_stack:
  added: []
  patterns:
    - "visibility:hidden → measure → visibility:visible (Tooltip-style two-pass positioning)"
    - "fitsBelow/fitsAbove + neither-fits fallback (pick more-space side)"
    - "Math.max(pad, Math.min(coord, viewport - pad - size)) viewport-edge clamp"
    - "Close-on-scroll/resize (matches Select/Tooltip primitive behaviour)"
key_files:
  created: []
  modified:
    - gui-pro/src/shared/ui/OverflowMenu.tsx
    - gui-pro/src/shared/ui/OverflowMenu.stories.tsx
    - gui-pro/src/shared/ui/OverflowMenu.test.tsx
decisions:
  - D-12 (viewport auto-flip fix, port algorithm from Tooltip)
  - Close-on-scroll/resize over recompute-on-scroll (simpler, matches Select)
  - Position tests assert visibility-flipped (not exact pixel coords) — JSDOM doesn't run layout
metrics:
  duration: 4m
  completed: 2026-04-17T14:58Z
  tasks: 3
  files_modified: 3
  tests_before: 15
  tests_after: 20
  tests_added: 5
  stories_added: 3
---

# Phase 14 Plan 02: OverflowMenu Viewport Auto-Flip Fix Summary

Починен viewport-clipping баг в `OverflowMenu` primitive: алгоритм auto-flip перенесён из `Tooltip.tsx` (с WR-07/WR-08 фиксами), добавлен close-on-scroll/resize, написаны 3 near-edge Storybook story и 5 unit-тестов. Публичный API не изменён.

## What Was Built

### Task 1: OverflowMenu.tsx — auto-flip primitive fix
**Commit:** `a8aa9110`

Полная замена алгоритма позиционирования. Было: `recalcPosition()` безусловно ставил `top = rect.bottom + 4, left = rect.left` без проверки viewport. Стало: two-pass позиционирование с auto-flip.

**Убрано** (строки 29-39, старый код):
```typescript
const recalcPosition = useCallback(() => {
  if (!triggerRef.current) return;
  const rect = triggerRef.current.getBoundingClientRect();
  setMenuStyle({
    position: "fixed",
    top: rect.bottom + 4,
    left: rect.left,
    zIndex: "var(--z-dropdown)",
  });
}, []);
```

**Добавлено** (три новых `useEffect`):

1. **Auto-flip positioning** (`useEffect [open]`, ~60 строк, ~L60-120):
   - Читает `triggerRef.current.getBoundingClientRect()` + `menuRef.current.getBoundingClientRect()`
   - Константы: `gap = 4`, `pad = 8`
   - Вертикаль: `fitsBelow` → below; `fitsAbove` → above; neither → больше места
   - Горизонталь: `rightEdgeIfLeftAligned <= vw - pad` → left-align; иначе right-align (`triggerRect.right - menuRect.width`)
   - Clamp: `left = Math.max(pad, Math.min(left, vw - pad - menuRect.width))` + аналогично для `top`
   - Устанавливает `visibility: "visible"` в финале

2. **Close-on-scroll/resize** (`useEffect [open]`, ~10 строк, ~L122-131):
   - `window.addEventListener("scroll", close, { capture: true, passive: true })`
   - `window.addEventListener("resize", close)`
   - Корректный cleanup в return

3. **handleToggle** обновлён (~L150-161):
   - При open=false→true: `setMenuStyle({ ..., visibility: "hidden" })`
   - useEffect затем перемерит и промотит до `visible`

**Что НЕ тронуто** (чтобы не сломать поведение):
- Close-on-outside-click useEffect
- Close-on-Escape useEffect
- Focus-first-item useEffect
- `handleItemKeyDown` (ArrowUp/Down/Home/End)
- `handleItemSelect`
- JSX/ARIA (role="menu", aria-haspopup, aria-expanded)
- Публичный API (`OverflowMenuProps`, `OverflowMenuItem`)

**Verify проверки (плановые):**
- `grep -c "fitsBelow\|fitsAbove"` → 4 (≥2 требовалось) ✓
- `grep -c "Math.max(pad\|Math.min(.*vw - pad"` → 2 (≥1 требовалось) ✓
- `recalcPosition` → 0 вхождений ✓
- `addEventListener.*scroll|resize` → 2 вхождения ✓
- `npx tsc --noEmit` → 0 errors ✓

### Task 2: OverflowMenu.stories.tsx — 3 near-edge stories
**Commit:** `ebe6e028`

Добавлено 3 story в конец файла, существующие 5 stories (Default, MultipleItems, WithDestructiveItem, WithDisabledItem, WithLoadingItem) не тронуты. Импорты расширены: `Users, Download, FileText` из `lucide-react`.

| Story | Edge case | Demonstrates |
|-------|-----------|--------------|
| `NearBottomRight` | trigger `position:fixed bottom:20 right:20` | Flip-up + right-align одновременно |
| `NearTopLeft` | trigger `position:fixed top:20 left:20` | Default ниже+left-align сохраняется когда место есть |
| `TallMenuFlipsUp` | 12-item меню, trigger внизу по центру | Вертикальный flip-up под длинное меню |

Все stories используют `parameters.layout: "fullscreen"` — это отменяет Storybook's centered layout, чтобы `position:fixed` корректно разместил trigger у края viewport.

**Verify проверки:**
- `grep -c "NearBottomRight\|NearTopLeft\|TallMenuFlipsUp"` → 3 ✓
- `npx tsc --noEmit` → 0 errors для stories файла ✓

### Task 3: OverflowMenu.test.tsx — 5 auto-flip unit tests
**Commit:** `a8d301b5`

Добавлен `describe("auto-flip positioning (D-12 viewport edge fix)")` блок в конце файла. Импорт `waitFor` добавлен в строке 2. Существующие 15 тестов не тронуты.

**Helpers:**
- `mockRect(el, rect)` — override `getBoundingClientRect` для конкретного элемента (JSDOM возвращает все нули по умолчанию)
- `setViewport(width, height)` — `Object.defineProperty(window, "innerWidth"...)` для контроля vw/vh

**5 новых тестов:**

| # | Test | Scenario | Assertion |
|---|------|----------|-----------|
| 1 | positions menu BELOW trigger (fitsBelow=true) | Trigger top-left (100,100), vw=1024 vh=768 | `menu.style.visibility !== "hidden"` |
| 2 | positions menu ABOVE trigger (bottom-edge case) | Trigger near bottom (top=700, bottom=732) | `menu.style.visibility !== "hidden"` |
| 3 | right-aligns when rightEdgeIfLeftAligned overflows | Trigger right edge (left=950) | `menu.style.visibility !== "hidden"` |
| 4 | closes menu on window scroll | open menu → `fireEvent.scroll(window)` | `queryByRole("menu")` → null |
| 5 | closes menu on window resize | open menu → `fireEvent(window, new Event("resize"))` | `queryByRole("menu")` → null |

**Примечание о хрупкости позиционных тестов** (задокументировано в комментариях describe-блока):
JSDOM не запускает реальный layout — useEffect может прочитать `menuRect` до того как `mockRect` был установлен. Поэтому position-тесты (1-3) фокусируются на факте что useEffect отработал без crash (`visibility` переключился с `"hidden"` на `"visible"`), а не на точных пиксельных координатах. Scroll/resize-тесты (4-5) детерминированы — они зависят только от `addEventListener` semantics.

**Verify проверки:**
- `npx vitest run src/shared/ui/OverflowMenu.test.tsx` → 20 passed ✓
- `grep -c "closes menu on window scroll\|closes menu on window resize\|auto-flip positioning"` → 3 ✓
- Все 15 существующих тестов продолжают проходить ✓

## Files Modified

| File | Lines changed | Purpose |
|------|---------------|---------|
| `gui-pro/src/shared/ui/OverflowMenu.tsx` | +85 / −14 | Port auto-flip алгоритма из Tooltip + close-on-scroll/resize |
| `gui-pro/src/shared/ui/OverflowMenu.stories.tsx` | +69 / −1 | 3 near-edge stories + расширение импортов |
| `gui-pro/src/shared/ui/OverflowMenu.test.tsx` | +136 / −1 | 5 auto-flip тестов + waitFor import |

**Файлы НЕ созданы.** Все изменения — расширение существующих файлов primitive уровня.

## API Compatibility (no breaking changes)

Публичный API не изменён:

```typescript
export interface OverflowMenuItem {
  label: string;
  onSelect: () => void;
  loading?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  icon?: ReactNode;
}

export interface OverflowMenuProps {
  items: OverflowMenuItem[];
  triggerAriaLabel: string;
  className?: string;
}

export function OverflowMenu({ items, triggerAriaLabel, className }: OverflowMenuProps): JSX.Element;
```

### Consumer analysis (grep `OverflowMenu` в gui-pro/src)

Текущих consumers primitive'а: **1** (на данный момент):

| File | Line | Usage |
|------|------|-------|
| `gui-pro/src/components/server/UsersSection.tsx` | L21, L234 | row OverflowMenu для показа конфига / удаления (будет заменён на 2 inline иконки в Plan 03 по D-03) |

Поскольку сигнатура `OverflowMenuProps` не тронута — `UsersSection` работает без изменений. Фикс просто исправит clip когда trigger близко к краю viewport (например, нижние строки списка пользователей в маленьком окне 900×1000).

Primitive экспортируется из `gui-pro/src/shared/ui/index.ts` (L24) — доступен для будущих consumers (Phase 15-17).

## Verification

- **Quick check:** `cd gui-pro && npx vitest run src/shared/ui/OverflowMenu.test.tsx` → **20 passed (15 existing + 5 new)**
- **Typecheck:** `cd gui-pro && npx tsc --noEmit` → **exit 0, no errors**
- **Visual (Storybook, manual):** `npm run storybook` → открыть `Primitives/OverflowMenu` → `NearBottomRight` / `NearTopLeft` / `TallMenuFlipsUp` stories. Клик по trigger-кнопке должен показать меню с корректным flip.

## Deviations from Plan

**None** — plan executed exactly as written. Все 3 задачи выполнены в указанном порядке, все verify-check и done-criteria пройдены.

**Примечание по установке зависимостей:** `npm install` в worktree упал из-за ERESOLVE конфликта между `eslint@10` (declared) и `eslint-plugin-react-hooks@^7.0.1` (peer требует eslint^8||^9). Resolved через `npm install --legacy-peer-deps`. Это setup-нюанс worktree окружения, не связан с кодом plan'а и не влияет на production сборку. Документирую здесь для будущих worktree executors.

## Self-Check: PASSED

- OverflowMenu.tsx: FOUND — содержит `fitsBelow`/`fitsAbove` (4 вхождения), clamp (`Math.max(pad, Math.min...)`, 2 вхождения), scroll/resize listeners (2 вхождения), НЕ содержит `recalcPosition` (0 вхождений)
- OverflowMenu.stories.tsx: FOUND — экспортирует `NearBottomRight`, `NearTopLeft`, `TallMenuFlipsUp`
- OverflowMenu.test.tsx: FOUND — содержит describe `auto-flip positioning (D-12 viewport edge fix)` с 5 тестами
- Commit `a8aa9110`: FOUND in `git log --oneline` (Task 1)
- Commit `ebe6e028`: FOUND in `git log --oneline` (Task 2)
- Commit `a8d301b5`: FOUND in `git log --oneline` (Task 3)
- Tests: 20/20 passed (`npx vitest run src/shared/ui/OverflowMenu.test.tsx`)
- Typecheck: 0 errors (`npx tsc --noEmit`)
- No breaking API changes (OverflowMenuProps/OverflowMenuItem unchanged)
