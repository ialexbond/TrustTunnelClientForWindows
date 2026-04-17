---
phase: 14-overflow-menu-dns-upstream-auto-qr
plan: 04
subsystem: frontend
tags: [modal, clipboard, qr, tauri-invoke, activity-log, security-tested]
dependency_graph:
  requires:
    - "14-01 (UserConfigModal stub + props contract + i18n keys)"
  provides:
    - "Production UserConfigModal compound (QR copy-image, deeplink copy, .toml download)"
    - "UserConfigModal test suite (15 unit tests including D-29 security audit)"
  affects:
    - "Plan 14-05 (UsersSection rewrite — integrates modal via FileText click + auto-after-add)"
tech_stack:
  added: []
  patterns:
    - "SVG -> canvas -> PNG rasterization with white-background fill for cross-target paste compatibility"
    - "ClipboardItem feature-detect -> graceful fallback to clipboard.writeText (D-09)"
    - "Activity log spy + secret-in-payload assertion as a D-29 security regression test"
    - "Storybook escape-hatch props short-circuit runtime state in useEffect so forced states are authoritative"
    - "Auto-focus close button via setTimeout 250ms after Modal enter animation settles"
key_files:
  created:
    - gui-app/src/components/server/UserConfigModal.test.tsx
  modified:
    - gui-app/src/components/server/UserConfigModal.tsx
decisions:
  - "useEffect теперь коротко-замыкает invoke когда передан _forceLoading или _forceError — форсированное состояние становится источником правды для storybook без гонки с runtime loading state."
  - "URL.revokeObjectURL вызывается сразу после img.onload, до Canvas toBlob — без этого object URL утекает если blob-построение падает в catch."
  - "Fallback путь при отсутствии ClipboardItem копирует текст (а не QR) + логирует fallback=no-clipboarditem — пользователь получает полезное действие вместо тихого отказа."
  - "Canvas заливается #ffffff перед drawImage — прозрачный PNG в некоторых paste-target'ах (Paint, Telegram Desktop) выглядит чёрным из-за alpha handling."
  - "Download error surface через pushSuccess(msg, 'error') — использует существующий SnackBar error-variant вместо отдельной error-banner внутри модала (error state зарезервирован только для provisioning failure)."
  - "`global` заменён на `globalThis` в тестовых ClipboardItem моках — tsconfig без @types/node всё равно знает globalThis."
metrics:
  duration_minutes: 20
  completed: 2026-04-17
  tasks_completed: 2
  commits: 1
  files_created: 1
  files_modified: 1
  tests_added: 15
---

# Phase 14 Plan 04: UserConfigModal production implementation Summary

Plan 14-01 оставил UserConfigModal как минимальный визуальный stub с правильной props-сигнатурой. Этот план заменяет внутренности на production-flow: invoke deeplink, clickable QR с copy-as-PNG через Canvas+ClipboardItem, read-only input с copy-иконкой, Download .toml через save dialog + copy_file. Storybook-only props (_deeplinkOverride/_forceLoading/_forceError) сохранены — stories из 14-01 работают без изменений. 15 unit тестов покрывают все состояния включая D-29 security audit, который явно проверяет что deeplink содержимое никогда не попадает в activity log payloads.

## What was built

**Note on commit strategy:** Initial Task 1 commit was made but history
surgery during the parallel worktree execution left the final diff as a
single commit `b9fe48c0` that contains both tasks' changes. The plan
document is preserved as-is for traceability — both task verifications
pass in the final commit.

### Task 1: UserConfigModal.tsx — production implementation

**Commit:** `b9fe48c0` (see note)

Файл: `gui-app/src/components/server/UserConfigModal.tsx` (+280 / −51)

**Структура рендера:**

| Состояние | Рендер |
|-----------|--------|
| `!isOpen` | `null` (early return — Modal primitive mount экономится) |
| `effectiveLoading` | Centered `Loader2` с `color: var(--color-accent-500)` |
| `effectiveError` | `ErrorBanner severity="error"` + `Button variant="secondary"` retry |
| `effectiveDeeplink` | QR 240px clickable + caption + deeplink input + Copy icon + Download button |

**Вычисление эффективного состояния:**
```typescript
const effectiveLoading = _forceLoading ?? deeplinkLoading;
const effectiveError = _forceError ?? deeplinkError;
const effectiveDeeplink = effectiveError ? null : deeplink ?? "";
```
Storybook-props имеют приоритет над runtime state.

**Handlers:**

- `handleRetry` — повторный invoke `server_export_config_deeplink`.
- `handleCopyLink` — `navigator.clipboard.writeText(deeplink)` + SnackBar `server.users.link_copied` + activity `USER user.config.link_copied user=X`.
- `handleCopyQr` — feature-detect `ClipboardItem`, иначе fallback к `writeText` с activity `fallback=no-clipboarditem`; happy path рисует SVG в 240×240 canvas с белой заливкой, конвертирует через `canvas.toBlob('image/png')`, пишет в clipboard через `ClipboardItem`. Cleanup: `URL.revokeObjectURL` после `img.onload`. Catch-fallback: copy text.
- `handleDownload` — `fetch_server_config` → `save({defaultPath: "trusttunnel_{user}.toml", filters: [{name, extensions: ["toml"]}]})` → `copy_file`. Dest=null (user cancelled) — silently return. Error — SnackBar error. Activity: `USER download_initiated` + `STATE downloaded` / `ERROR download_failed`.

**Invariants:**

1. `if (!isOpen) return null` — early return до вызова Modal.
2. `useEffect` при открытии сбрасывает state если закрыт/нет username; storybook props short-circuit invoke.
3. `closeButtonRef.current?.focus()` через `setTimeout 250ms` после open — учитывает Modal enter animation (`requestAnimationFrame` × 2 + 200ms CSS transition).
4. Activity log payload содержит только `user=X` — **никогда** deeplink/password (D-29).

**Props contract preserved** от 14-01:
```typescript
{
  isOpen: boolean;
  username: string | null;
  sshParams: { host, port: number, user, password, keyPath? };
  onClose: () => void;
  _deeplinkOverride?: string;  // storybook-only
  _forceLoading?: boolean;     // storybook-only
  _forceError?: string;        // storybook-only
}
```

### Task 2: UserConfigModal.test.tsx — 15 unit tests

**Commit:** `b9fe48c0`

Файл: `gui-app/src/components/server/UserConfigModal.test.tsx` (+389)

**Mocks:**
- `qrcode.react` → простой `<svg data-testid="qr-code" data-value=...>` (runtime QR рендер не нужен для behaviour-тестов).
- `@tauri-apps/api/core` invoke → `vi.fn()`.
- `@tauri-apps/plugin-dialog` save → `vi.fn()`.
- `useActivityLog` → возвращает `{ log: activityLogSpy }` — spy для D-29.
- `navigator.clipboard` → `{ writeText: vi.fn, write: vi.fn }` через `Object.assign`.
- `globalThis.ClipboardItem` → class stub, удаляется в fallback-тестах.

**Покрытие:**

| # | Тест | Что проверяет |
|---|------|---------------|
| 1 | does not render when isOpen=false | Early return, нет `[role="dialog"]` в DOM |
| 2 | fetches deeplink via invoke when opened | `invoke("server_export_config_deeplink", {...sshParams, clientName})` |
| 3 | renders QR code with fetched deeplink (240px) | data-value + width attribute |
| 4 | bypasses invoke when _deeplinkOverride provided | Storybook prop short-circuits invoke |
| 5 | calls onClose when X button clicked | onClose handler |
| 6 | copies deeplink text when Copy icon clicked (D-23) | clipboard.writeText + activity log |
| 7 | falls back to text copy when ClipboardItem unavailable (D-09) | `delete globalThis.ClipboardItem` → writeText + `fallback=no-clipboarditem` в logs |
| 8 | **D-29 SECURITY: activity log never contains deeplink value** | `_deeplinkOverride` с `ABC-SECRET-DO-NOT-LEAK-123` — проходим по всем activityLog вызовам и проверяем что message не содержит секрет |
| 9 | Download button invokes fetch_server_config + save + copy_file (D-27) | Happy path: 3 invokes + STATE downloaded log |
| 10 | Download cancelled (user closes save dialog) does not invoke copy_file | save→null → `copy_file` не вызывается |
| 11 | shows loading state when deeplink fetch is in flight | Never-resolving invoke → spinner |
| 12 | shows error state with retry button when deeplink fetch fails | invoke rejects → ErrorBanner + retry button |
| 13 | retries deeplink fetch when retry button clicked | Click retry → second invoke |
| 14 | _forceLoading prop displays loading state (storybook) | Spinner visible |
| 15 | _forceError prop displays error state (storybook) | Error message visible |

## D-29 Security Proof

Дословный тест (строки 181-212 в UserConfigModal.test.tsx):

```typescript
it("D-29 SECURITY: activity log never contains deeplink value", async () => {
  delete (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem;

  const secret =
    "tt://example.com/config?secret_token=ABC-SECRET-DO-NOT-LEAK-123";
  render(
    <UserConfigModal
      isOpen={true}
      username="swift-fox"
      sshParams={mockSshParams}
      onClose={vi.fn()}
      _deeplinkOverride={secret}
    />,
  );
  const qrBtn = await screen.findByRole("button", {
    name: i18n.t("server.users.qr_click_to_copy"),
  });
  const copyBtn = await screen.findByRole("button", {
    name: i18n.t("server.users.copy_deeplink_tooltip"),
  });
  fireEvent.click(qrBtn);
  fireEvent.click(copyBtn);
  await waitFor(() => {
    expect(activityLogSpy).toHaveBeenCalled();
  });

  const allLogCalls = activityLogSpy.mock.calls;
  for (const call of allLogCalls) {
    const message = String(call[1] ?? "");
    expect(message).not.toContain("ABC-SECRET-DO-NOT-LEAK-123");
    expect(message).not.toContain("secret_token");
  }
});
```

Тест делает оба клика (QR copy через fallback путь + Copy icon), собирает все activity log payloads и asserts что ни один не содержит ни секрет-substring, ни строку `secret_token`. Это audit-test для threat register T-14-01 (Information Disclosure через activity log).

## Canvas rasterization detail

QR копируется как PNG через Canvas API (строки 139-218 UserConfigModal.tsx):

1. `XMLSerializer().serializeToString(svg)` — получаем SVG-XML строку.
2. `new Blob([svgData], { type: "image/svg+xml;charset=utf-8" })` + `URL.createObjectURL` — создаём object URL.
3. Canvas 240×240, `ctx.fillStyle = "#ffffff"` + `fillRect(0, 0, 240, 240)` — **белый фон обязателен**, без него paste в Paint/Telegram Desktop может выглядеть чёрным из-за alpha handling.
4. `new Image()` + `await new Promise(...img.onload)` — ожидаем загрузку SVG как битмап.
5. `ctx.drawImage(img, 0, 0, 240, 240)` — рисуем.
6. `URL.revokeObjectURL(svgUrl)` — **сразу после onload**, до toBlob. Без этого object URL утекает если toBlob упадёт в catch.
7. `canvas.toBlob(..., "image/png")` — получаем PNG blob.
8. `navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])` — пишем в буфер.

Любой throw в этой цепочке перехватывается, пишется ERROR в activity log, и fallback копирует deeplink text — пользователь всё равно получает полезное действие.

## Integration points (Plan 14-05)

Props signature не менялась — Plan 14-05 интегрирует модал в UsersSection как:

```typescript
// Trigger 1: FileText inline icon в row
<UserConfigModal
  isOpen={modalUsername !== null}
  username={modalUsername}
  sshParams={sshParams}
  onClose={() => setModalUsername(null)}
/>

// Trigger 2: auto-open после add_server_user (D-07)
// Хэндлер add проставляет setPendingExportUsername(username) → useEffect
// перебрасывает в setModalUsername(pendingExportUsername).
```

Storybook props **не используются** production call sites.

## Verification

- [x] `npx tsc --noEmit` → clean (после замены `global` → `globalThis` в 3 mock usages)
- [x] `npx eslint UserConfigModal.tsx UserConfigModal.test.tsx --max-warnings 0` → 0 errors / 0 warnings
- [x] `npx vitest run UserConfigModal.test.tsx` → **15/15 passed** (duration 343ms, setup 124ms)
- [x] Grep счётчики плана:
  - `server_export_config_deeplink|ClipboardItem|fetch_server_config|copy_file` → 4+ (verified: 3 + 4 + 2 + 2 = 11 в UserConfigModal.tsx)
  - `user\.config\.` → 9 (план требует ≥5)
  - `_deeplinkOverride|_forceLoading|_forceError` → 11 (план требует ≥3)
  - `ErrorBanner` → 2 impoprt + usage
- [x] Storybook stories из 14-01 (`UserConfigModal.stories.tsx`) продолжают типизироваться — props contract не менялся.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 — Bug] `_forceError` тест падал — storybook error-prop не short-circuit'ил runtime loading state**
- **Found during:** Task 2 initial test run (14/15 passed)
- **Issue:** Когда `_forceError` задан и `_deeplinkOverride` не задан, `useEffect` запускал `setDeeplinkLoading(true)` и вызывал invoke. `effectiveLoading = _forceLoading ?? deeplinkLoading` возвращал `true`, модал показывал spinner вместо error.
- **Fix:** useEffect теперь коротко-замыкает invoke когда передан `_forceLoading || _forceError !== undefined` — форсированное состояние становится источником правды для storybook. Добавил `_forceLoading, _forceError` в deps массив.
- **Files modified:** `gui-app/src/components/server/UserConfigModal.tsx`
- **Commit:** `b9fe48c0`

**2. [Rule 3 — Blocker] TS2304 "Cannot find name 'global'"**
- **Found during:** Task 2 typecheck
- **Issue:** Тесты используют `(global as unknown as { ClipboardItem: ... })` — `global` не определено в tsconfig без `@types/node`.
- **Fix:** Заменил все 3 вхождения `(global as unknown` → `(globalThis as unknown)` — `globalThis` стандартная ECMAScript переменная, не требует node types.
- **Files modified:** `gui-app/src/components/server/UserConfigModal.test.tsx`
- **Commit:** `b9fe48c0` (тот же commit, inline fix при написании test файла)

### Interpretation of ambiguous guidance

**3. Plan suggested checking for ErrorBanner presence**
- Plan содержал ПРЕ-СТУПЕНЬ `ls gui-app/src/shared/ui/ErrorBanner.tsx` с NO_ERRORBANNER fallback. ErrorBanner существует (`severity="error"` + `message` props подтверждены из файла). Использовал штатный импорт — fallback-путь не требовался.

**4. Plan's canvas happy-path test**
- Plan prescribes "handleCopyQr в тесте с ClipboardItem может падать на canvas.toBlob(null) — деферим". Я не включил happy-path canvas тест — vitest/JSDOM не реализует canvas. Тест D-09 сфокусирован на fallback (delete ClipboardItem → writeText), что даёт покрытие без canvas polyfill. Happy-path верифицируется через Storybook Default story (`_deeplinkOverride`) + E2E в будущем.

**5. TSC requires explicit types for `global`**
- Plan рекомендовал `(global as unknown as { ClipboardItem: unknown })`. Заменил на `globalThis` (см. Fix #2). Эквивалентно но type-safe без внешних зависимостей.

## Known Stubs

None — все функции действительно делают то, что заявлено. QR happy-path canvas work не покрыт unit-тестом (JSDOM ограничение), но логика реализована полностью и покрывается Storybook Default story + будущим E2E.

## Threat Surface Scan

Этот план **mitigates** threat T-14-01 (Information Disclosure через activity log) — D-29 security test предоставляет автоматизированный regression check. Новых threat surfaces вне плана не введено.

## Self-Check: PASSED

**Files:**
- FOUND: gui-app/src/components/server/UserConfigModal.tsx (modified, 369 lines production-ready)
- FOUND: gui-app/src/components/server/UserConfigModal.test.tsx (created, 389 lines, 15 tests)

**Commits (verified via `git log`):**
- FOUND: b9fe48c0 test(14-04): add 15 unit tests for UserConfigModal + short-circuit _forceLoading/_forceError (contains Task 1 implementation + Task 2 tests)

**Verification:**
- PASS: `npx tsc --noEmit` (no errors)
- PASS: `npx eslint --max-warnings 0` on both files
- PASS: `npx vitest run UserConfigModal.test.tsx` — 15/15 passed in 343ms
- PASS: Grep counters meet plan thresholds (11 ≥ 4, 9 ≥ 5, 11 ≥ 3)
- PASS: D-29 security invariant enforced by unit test
- PASS: Props contract unchanged from Plan 14-01 (stories continue to work)
