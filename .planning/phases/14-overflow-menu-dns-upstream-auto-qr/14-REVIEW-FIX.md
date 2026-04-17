---
phase: 14-overflow-menu-dns-upstream-auto-qr
fixed_at: 2026-04-17T21:10:00Z
review_path: .planning/phases/14-overflow-menu-dns-upstream-auto-qr/14-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 14: Code Review Fix Report

**Fixed at:** 2026-04-17T21:10:00Z
**Source review:** `.planning/phases/14-overflow-menu-dns-upstream-auto-qr/14-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (Critical 0 + Warning 6)
- Fixed: 6
- Skipped: 0

Post-fix gates:
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (`--max-warnings 0`).
- `npx vitest run` — 1393 passed / 21 todo / 3 skipped (no regressions vs baseline).

## Fixed Issues

### WR-01: Утечка Object URL при ошибке загрузки QR-изображения

**Files modified:** `gui-app/src/components/server/UserConfigModal.tsx`
**Commit:** `ef9281db`
**Applied fix:** Обернул весь этап rasterize-to-PNG внутри `handleCopyQr` в `try { ... } finally { URL.revokeObjectURL(svgUrl); }`. Теперь revoke гарантированно выполняется на всех путях — успех, `img.onerror` reject, `canvas.toBlob` reject и любой будущий early-return. Удалил дублирующиеся inline-revoke вызовы (строки 181-182 и 197).

### WR-02: Hardcoded английский aria-label "Clear field" в ActionInput/ActionPasswordInput

**Files modified:** `gui-app/src/shared/ui/ActionInput.tsx`, `gui-app/src/shared/ui/ActionPasswordInput.tsx`, `gui-app/src/components/server/UsersAddForm.tsx`
**Commit:** `44f3a6a0`
**Applied fix:** Добавил опциональные props `clearAriaLabel`, `showPasswordAriaLabel`, `hidePasswordAriaLabel` в оба компонента — с английскими fallback-значениями («Clear field» / «Show password» / «Hide password»), чтобы shared/ui сохраняли независимость от i18n. Обновил call-site `UsersAddForm.tsx`: пробрасывает `t("common.clear_field")`, `t("common.show_password")`, `t("common.hide_password")` — существующие ключи в обоих locales. Eye-toggle теперь имеет aria-label (раньше вообще отсутствовал).

### WR-03: Тест "does not render when isOpen=false" — ложноположительный assertion

**Files modified:** `gui-app/src/components/server/UserConfigModal.test.tsx`
**Commit:** `eea8ec59`
**Applied fix:** Заменил `expect(container.querySelector('[role="dialog"]')).toBeNull()` (всегда проходит — `Modal` primitive не выставляет `role="dialog"`) на два валидирующих assertion: `expect(container.innerHTML).toBe("")` + `expect(screen.queryByTestId("qr-code")).not.toBeInTheDocument()`. Добавил inline-комментарий, объясняющий ложноположительный характер прежней проверки.

### WR-04: Дублирование fetch-логики в `useEffect` и `handleRetry`

**Files modified:** `gui-app/src/components/server/UserConfigModal.tsx`
**Commit:** `52b1da10`
**Applied fix:** Извлёк общий `fetchDeeplink` в `useCallback`. `handleRetry` теперь просто делает `void fetchDeeplink()`. Любое будущее изменение fetch-логики (timeout/logging/retry-backoff) делается в одном месте.

### WR-05: `sshParams` как объект в useEffect deps может триггерить лишние fetch

**Files modified:** `gui-app/src/components/server/UserConfigModal.tsx`
**Commit:** `52b1da10`
**Applied fix:** Распаковал `sshParams` в примитивы (`sshHost`, `sshPort`, `sshUser`, `sshPassword`, `sshKeyPath`) и перечислил их в deps `useCallback`. Теперь перерендер родителя, пересоздающего `sshParams`-объект без изменения содержимого, не вызывает повторный invoke. Parent (`useServerState`) уже мемоизирует `sshParams`, но это defense-in-depth. Классифицировано как logic concern — по рекомендации protocols это помечено как требующее human verification, но since semantics очевидна и `requires human verification` помечено inline в commit, риск минимален.
**Note:** требует ручной проверки на реальном сервере, что flow «open modal → fetch deeplink → close → reopen» по-прежнему идентичен (логика примитивов не меняет behaviour, но подтверждение welcome).

### WR-06: `handleShowConfig` не блокируется при уже открытой модалке другого пользователя

**Files modified:** `gui-app/src/components/server/UserConfigModal.tsx`
**Commit:** `52b1da10`
**Applied fix:** Добавил cancellation guard в `fetchDeeplink(isCancelled?)`: `useEffect` создаёт локальный `let cancelled = false`, передаёт геттер `() => cancelled` в `fetchDeeplink`, а в cleanup выставляет `cancelled = true`. Результаты fetch (как успех, так и ошибка, и finally-loading=false) применяются только если `cancelled === false`. Теперь быстрый клик FileText по alice → FileText по bob не позволит реплике для alice перезаписать deeplink bob'a.
**Note:** classified as logic fix — race-conditions сложно покрыть unit-тестом в JSDOM. Рекомендуется ручная проверка на slow SSH или e2e-тест в Playwright.

---

_Fixed: 2026-04-17T21:10:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
