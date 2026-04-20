---
phase: 14-overflow-menu-dns-upstream-auto-qr
reviewed: 2026-04-17T21:00:00Z
depth: standard
files_reviewed: 15
files_reviewed_list:
  - gui-pro/src/components/server/UserConfigModal.stories.tsx
  - gui-pro/src/components/server/UserConfigModal.test.tsx
  - gui-pro/src/components/server/UserConfigModal.tsx
  - gui-pro/src/components/server/UsersAddForm.tsx
  - gui-pro/src/components/server/UsersSection.stories.tsx
  - gui-pro/src/components/server/UsersSection.test.tsx
  - gui-pro/src/components/server/UsersSection.tsx
  - gui-pro/src/shared/i18n/locales/en.json
  - gui-pro/src/shared/i18n/locales/ru.json
  - gui-pro/src/shared/ui/ActionInput.stories.tsx
  - gui-pro/src/shared/ui/ActionInput.tsx
  - gui-pro/src/shared/ui/ActionPasswordInput.stories.tsx
  - gui-pro/src/shared/ui/ActionPasswordInput.tsx
  - gui-pro/src/shared/ui/OverflowMenu.stories.tsx
  - gui-pro/src/shared/ui/OverflowMenu.test.tsx
  - gui-pro/src/shared/ui/OverflowMenu.tsx
findings:
  critical: 0
  warning: 6
  info: 8
  total: 14
status: issues_found
---

# Phase 14: Code Review Report

**Reviewed:** 2026-04-17T21:00:00Z
**Depth:** standard
**Files Reviewed:** 15
**Status:** issues_found

## Summary

Ревью нового compound UserConfigModal + редизайн UsersSection (D-03 inline icons), расширение ActionInput/ActionPasswordInput (`clearable` + `onVisibilityToggle`), auto-flip для OverflowMenu и 59 тестов.

**Общая оценка:** высокое качество. D-29 security invariant соблюдён полностью (пароли и значение deeplink никогда не попадают в activityLog — проверено grep-тестом). i18n parity идеальная (14/14 новых ключей в обоих locales). Алгоритм auto-flip в OverflowMenu корректно портирован из Tooltip, включая WR-08 neither-fits fallback. Escape/Backdrop/X закрытие модала работает.

**Основные замечания:**
1. Утечка Object URL в `handleCopyQr` при ошибке `img.onerror` (WR-01) — единственный существенный bug.
2. Hardcoded английский aria-label "Clear field" в ActionInput/ActionPasswordInput (WR-02) — нарушение i18n-принципа.
3. Ложно-положительный тест `isOpen=false` (WR-03) — Modal не выставляет `role="dialog"`, тест всегда пройдёт.
4. Closure stale в `handleRetry` (WR-04) — дублирование логики из useEffect может быть сокращено.
5. `useEffect` с `sshParams` в deps массиве триггерит fetch при каждом рендере, если родитель не мемоизирует объект (WR-05).
6. Несколько info-замечаний по упрощению и консистентности.

Критических проблем безопасности не обнаружено. Нет критических bug'ов. Код готов к merge после fix WR-01 и WR-02.

## Warnings

### WR-01: Утечка Object URL при ошибке загрузки QR-изображения

**File:** `gui-pro/src/components/server/UserConfigModal.tsx:174-197`

**Issue:** В `handleCopyQr` вызов `URL.createObjectURL(svgBlob)` создаёт Object URL, но `URL.revokeObjectURL(svgUrl)` вызывается только в двух случаях: (1) когда `ctx === null` (строка 181-182), (2) после успешного `ctx.drawImage` (строка 197). Если `img.onerror` срабатывает (строка 193) — Promise rejects, управление передаётся в catch-блок (строка 211), но `svgUrl` остаётся живым до GC блоба. На длинной сессии с плохим SVG-рендером это даёт утечку на 4-8 КБ на попытку.

Дополнительно: если `canvas.toBlob` rejects (null), revoke уже был (строка 197), но если добавится будущий early-return между строками 170 и 197, легко забыть revoke снова.

**Fix:**
```tsx
try {
  const svgData = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 240, 240);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("QR image load failed"));
      img.src = svgUrl;
    });
    ctx.drawImage(img, 0, 0, 240, 240);
    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Canvas toBlob returned null")), "image/png");
    });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    activityLog("USER", `user.config.qr_copied user=${username}`);
    pushSuccess(t("server.users.qr_copied"));
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
} catch (e) {
  activityLog("ERROR", `user.config.qr_copy_failed err=${formatError(e)}`);
  // fallback to text copy...
}
```
`try/finally` гарантирует revoke на всех путях.

---

### WR-02: Hardcoded английский aria-label "Clear field" в ActionInput/ActionPasswordInput

**File:** `gui-pro/src/shared/ui/ActionInput.tsx:118` и `gui-pro/src/shared/ui/ActionPasswordInput.tsx:124`

**Issue:** Clear-кнопка имеет `aria-label="Clear field"` — строка захардкожена на английском. В `ru.json:1125` и `en.json:1125` уже существует ключ `common.clear_field` («Очистить поле» / «Clear field»), но компоненты его не используют. Русскоязычные пользователи со screen reader услышат английскую метку.

Параллельно: eye-toggle button в ActionPasswordInput (строки 134-145) вообще не имеет `aria-label` — пользователи со screen reader не поймут, что это за кнопка. Существуют ключи `common.show_password` / `common.hide_password`.

**Fix:** Поскольку shared/ui не должен напрямую звать useTranslation (слой абстракции), лучше пробросить label как prop:
```tsx
// ActionInput.tsx:
interface ActionInputProps extends ... {
  ...
  /** aria-label for the Clear button (i18n from caller). Defaults to "Clear field". */
  clearAriaLabel?: string;
}
// ...
<button
  type="button"
  tabIndex={-1}
  onClick={handleClear}
  aria-label={clearAriaLabel ?? "Clear field"}
  ...
>
```

Либо в ActionPasswordInput для eye-toggle:
```tsx
interface ActionPasswordInputProps extends ... {
  ...
  showPasswordAriaLabel?: string;
  hidePasswordAriaLabel?: string;
}
// ...
<button
  ...
  aria-label={visible ? (hidePasswordAriaLabel ?? "Hide password") : (showPasswordAriaLabel ?? "Show password")}
>
```

И в call-sites (UsersAddForm.tsx) передать:
```tsx
<ActionInput
  ...
  clearAriaLabel={t("common.clear_field")}
/>
<ActionPasswordInput
  ...
  clearAriaLabel={t("common.clear_field")}
  showPasswordAriaLabel={t("common.show_password")}
  hidePasswordAriaLabel={t("common.hide_password")}
/>
```

---

### WR-03: Тест "does not render when isOpen=false" — ложноположительный assertion

**File:** `gui-pro/src/components/server/UserConfigModal.test.tsx:64-74`

**Issue:** Тест `expect(container.querySelector('[role="dialog"]')).toBeNull()` всегда пройдёт независимо от поведения UserConfigModal, потому что `Modal` (shared/ui/Modal.tsx) **не выставляет** атрибут `role="dialog"` на своих div'ах. Даже когда модал открыт и mounted, селектор вернёт null.

Фактический early-return в UserConfigModal.tsx:256 (`if (!isOpen) return null`) работает корректно, но тест его не валидирует.

**Fix:**
```tsx
it("does not render when isOpen=false", () => {
  const { container } = render(
    <UserConfigModal
      isOpen={false}
      username="swift-fox"
      sshParams={mockSshParams}
      onClose={vi.fn()}
    />,
  );
  // UserConfigModal returns null when isOpen=false — container stays empty
  expect(container.innerHTML).toBe("");
  // OR: assert the QR code testid is NOT present (it IS present when open)
  expect(screen.queryByTestId("qr-code")).not.toBeInTheDocument();
});
```

Дополнительно: как только Modal получит `role="dialog"` (A11y-улучшение), рекомендуется вернуться к оригинальному assertion, потому что это более семантично.

---

### WR-04: Дублирование fetch-логики в `useEffect` и `handleRetry`

**File:** `gui-pro/src/components/server/UserConfigModal.tsx:82-109` и `119-130`

**Issue:** `useEffect` (линии 82-109) и `handleRetry` (линии 119-130) содержат практически идентичный код fetch+setDeeplink/setError/setLoading. Изменение логики (например, добавление timeout или logging) требует правки в двух местах — легко забыть одно из них. Также `handleRetry` не учитывает Storybook-overrides (`_forceLoading`, `_forceError`), что не критично (stories не clickать retry), но рассогласовано.

**Fix:** Извлечь в общую функцию:
```tsx
const fetchDeeplink = useCallback(async () => {
  if (!username) return;
  setDeeplinkLoading(true);
  setDeeplinkError(null);
  try {
    const link = await invoke<string>("server_export_config_deeplink", {
      ...sshParams,
      clientName: username,
    });
    setDeeplink(link);
  } catch (e) {
    setDeeplinkError(formatError(e));
  } finally {
    setDeeplinkLoading(false);
  }
}, [username, sshParams]);

useEffect(() => {
  if (!isOpen || !username) {
    setDeeplink(null);
    setDeeplinkError(null);
    setDeeplinkLoading(false);
    return;
  }
  if (_forceLoading || _forceError !== undefined) {
    setDeeplinkLoading(false);
    return;
  }
  if (_deeplinkOverride !== undefined) {
    setDeeplink(_deeplinkOverride);
    setDeeplinkError(null);
    setDeeplinkLoading(false);
    return;
  }
  void fetchDeeplink();
}, [isOpen, username, _deeplinkOverride, _forceLoading, _forceError, fetchDeeplink]);

const handleRetry = () => { void fetchDeeplink(); };
```

---

### WR-05: `sshParams` как объект в useEffect deps может триггерить лишние fetch

**File:** `gui-pro/src/components/server/UserConfigModal.tsx:109`

**Issue:** `sshParams` включён в deps массив useEffect. Поскольку `sshParams` — plain object, React сравнивает его по reference. Если родитель (UsersSection) не мемоизирует `sshParams` и пересоздаёт объект на каждый рендер (что часто бывает), useEffect будет триггериться на каждый родительский re-render → повторный invoke `server_export_config_deeplink`, то есть лишний SSH round-trip.

Проверка UsersSection.tsx:394 — `sshParams={sshParams}` напрямую из state slice. В useServerState это `sshParams` из `useMemo` (вероятно), но это нужно проверить.

**Fix:** Два варианта:
1. Зависеть от примитивов (host/port/user):
   ```tsx
   }, [isOpen, username, sshParams.host, sshParams.port, sshParams.user, _deeplinkOverride, _forceLoading, _forceError]);
   ```
   Это минимизирует false-positive triggers. Пароль не включать в deps (не должен перефетчить, если пароль не менялся, а триггер по password бессмыслен — если он меняется, пользователь выйдет из модала).

2. Убедиться, что в useServerState.ts `sshParams` обёрнут в `useMemo`:
   ```tsx
   const sshParams = useMemo(() => ({ host, port, user, password, keyPath }), [host, port, user, password, keyPath]);
   ```

---

### WR-06: `handleShowConfig` не блокируется при уже открытой модалке другого пользователя

**File:** `gui-pro/src/components/server/UsersSection.tsx:145-148`

**Issue:** Если пользователь быстро кликнул FileText на alice, потом FileText на bob до того, как модалка для alice фактически mounted → `setModalUsername("alice")` → ещё не успел useEffect в UserConfigModal перезапустить fetch → `setModalUsername("bob")`. Получаем:
- модалка сразу открывается с username=bob (UserConfigModal видит новый username)
- fetch для alice уже в полёте, reply приедет в setDeeplink с deeplink для alice
- race condition: deeplink для alice может перезаписать результат для bob, если fetch для bob придёт раньше

Вероятность низкая, но возможна на медленном SSH. Также невидимо пользователю — он увидит корректный username, но QR будет неправильный.

**Fix:** В useEffect использовать abort pattern или "last-write-wins" guard:
```tsx
useEffect(() => {
  // ... early returns ...
  setDeeplinkLoading(true);
  setDeeplinkError(null);
  let cancelled = false;
  invoke<string>("server_export_config_deeplink", { ...sshParams, clientName: username })
    .then((link) => {
      if (!cancelled) setDeeplink(link);
    })
    .catch((e) => {
      if (!cancelled) setDeeplinkError(formatError(e));
    })
    .finally(() => {
      if (!cancelled) setDeeplinkLoading(false);
    });
  return () => { cancelled = true; };
}, [isOpen, username, sshParams, _deeplinkOverride, _forceLoading, _forceError]);
```
Это также исправляет race condition при быстром close/reopen модалки того же пользователя.

---

## Info

### IN-01: `_forceLoading` / `_forceError` / `_deeplinkOverride` в production API

**File:** `gui-pro/src/components/server/UserConfigModal.tsx:53-57`

**Issue:** Storybook-only props экспортируются как часть публичного `UserConfigModalProps` интерфейса. Любой call-site может случайно их передать. В Phase 14 Plan 04 SUMMARY документирует, что production call-sites не передают их, но TypeScript не запрещает.

**Fix:** Опционально — пометить underscore-префикс достаточно строгий для code review, но можно явно запретить через eslint-override или вынести в отдельный `StorybookOnlyProps`:
```tsx
export interface UserConfigModalProps {
  isOpen: boolean;
  username: string | null;
  sshParams: {...};
  onClose: () => void;
}

// Extended for Storybook only
interface UserConfigModalPropsWithOverrides extends UserConfigModalProps {
  _deeplinkOverride?: string;
  _forceLoading?: boolean;
  _forceError?: string;
}

// export default regular type, import extended only in stories
```

Не критично — underscore-prefix + JSDoc комментарий («Storybook-only») достаточно.

---

### IN-02: Auto-flip useEffect: порядок setState при open

**File:** `gui-pro/src/shared/ui/OverflowMenu.tsx:144-156`

**Issue:** В `handleToggle` вызывается `setMenuStyle({ ..., visibility: "hidden" })` **до** `setOpen((prev) => !prev)`. Но React batches state updates — оба state-change применятся в одном render cycle. При закрытии `open` переключается в false, menuStyle с visibility:hidden остаётся в state до следующего open. Это не баг (closure), но лишний state update.

Также: `handleToggle` мемоизирован с deps `[open]` — при каждом click создаётся новый `handleToggle` reference → IconButton получит новый `onClick` prop → лишний re-render. Не критично, но пахнет.

**Fix:** Можно упростить:
```tsx
const handleToggle = useCallback(() => {
  setOpen((prev) => {
    if (!prev) {
      // Опционально: сразу выставить hidden style (но это делает auto-flip useEffect)
      setMenuStyle({
        position: "fixed", top: 0, left: 0,
        zIndex: "var(--z-dropdown)",
        visibility: "hidden",
      });
    }
    return !prev;
  });
}, []); // No deps — setOpen/setMenuStyle stable
```

---

### IN-03: Тесты auto-flip в JSDOM — проверяют только отсутствие visibility:hidden

**File:** `gui-pro/src/shared/ui/OverflowMenu.test.tsx:197-268`

**Issue:** Тесты в блоке "auto-flip positioning" помечают rect через `mockRect`, потом ждут смены `visibility` с "hidden" на non-hidden. Но JSDOM не выполняет layout → `menuRef.current.getBoundingClientRect()` всегда возвращает `{0,0,0,0,...}` если mockRect на menu вызван **после** useEffect измерил (что и происходит — fireEvent.click запускает synchronous effect). По факту эти тесты проверяют только "effect не упал с exception". Комментарий в тесте (строки 167-171) это признаёт.

Это не false-positive, но слабая защита от регрессии. Если кто-то случайно уберёт `setMenuStyle({...visibility:visible})`, тесты пройдут.

**Fix (optional):** Использовать `@testing-library/react` helper `act()` с моковыми прямоугольниками **до** click, либо подменить `getBoundingClientRect` на уровне `HTMLElement.prototype`:
```tsx
beforeEach(() => {
  // Default rects that make fitsBelow=true
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function() {
    const elId = (this as HTMLElement).getAttribute("data-test-id");
    if (elId === "trigger") return { top: 100, left: 100, bottom: 132, right: 140, width: 40, height: 32, x: 100, y: 100, toJSON: () => ({}) };
    if (elId === "menu") return { top: 0, left: 0, bottom: 100, right: 160, width: 160, height: 100, x: 0, y: 0, toJSON: () => ({}) };
    return DOMRect.fromRect();
  });
});
```
Либо мигрировать на Playwright для реальных layout-тестов. Не блокирует.

---

### IN-04: OverflowMenu — firstEnabled focus: refs может быть stale

**File:** `gui-pro/src/shared/ui/OverflowMenu.tsx:135-142`

**Issue:** `itemRefs.current.find((el) => el && !el.disabled)` читает refs в useEffect, который запускается при `open → true`. При первом рендере меню items могут не успеть mount → refs ещё `null`. Обёртка `requestAnimationFrame(() => firstEnabled.focus())` откладывает fokus, но если items mount после первого RAF, focus пропадёт.

На практике — React рендерит menu синхронно, refs заполняются к моменту useEffect, rAF гарантирует портал paint. Работает.

**Fix:** Не требуется, но можно явно перепроверить refs внутри rAF:
```tsx
useEffect(() => {
  if (!open) return;
  requestAnimationFrame(() => {
    const firstEnabled = itemRefs.current.find((el) => el && !el.disabled);
    firstEnabled?.focus();
  });
}, [open]);
```

---

### IN-05: UsersSection useEffect mount-only pre-fill — lint disable

**File:** `gui-pro/src/components/server/UsersSection.tsx:104-109`

**Issue:** `useEffect` pre-fill пишет `setNewUsername` + `setNewPassword` один раз на mount с пустым deps `[]` и eslint-disable. Это обходит react-hooks/exhaustive-deps. Корректно работает, но обход lint рисков — если в будущем кто-то добавит условие, зависящее от `serverInfo.users`, deps уже пустые и regenerate не сработает.

**Fix:** Можно использовать `useRef` флаг:
```tsx
const didPrefill = useRef(false);
useEffect(() => {
  if (didPrefill.current || !serverInfo) return;
  didPrefill.current = true;
  const existing = serverInfo.users ?? [];
  setNewUsername(generateUniqueUsername(existing, 10));
  setNewPassword(generatePassword());
}, [serverInfo, setNewUsername, setNewPassword]);
```

Это снимает lint-disable и делает мёртвые изменения deps видимыми.

---

### IN-06: Inconsistent right-padding calculation ActionInput vs ActionPasswordInput

**File:** `gui-pro/src/shared/ui/ActionInput.tsx:64-68` и `gui-pro/src/shared/ui/ActionPasswordInput.tsx:69-74`

**Issue:** ActionInput считает: `rightPadding = 8 + effectiveActionCount * 28` (шаг 28px/icon).  
ActionPasswordInput считает: `rightPadding = 8 + totalIconCount * 22 + Math.max(0, totalIconCount - 1) * 4` (шаг 22px/icon + gap 4px).

Разные формулы для «примерно одинакового» layout (flex с gap-1 + p-1 кнопки). Комментарии в коде указывают разные числа (28 vs 22). Если дизайн требует пиксель-в-пиксель match, одна из формул неверна.

**Fix:** Унифицировать. Реальный размер icon-wrapper: `p-1` = 4px padding × 2 + 14px icon = 22px total. Gap-1 = 4px. Base `right-2` = 8px. Формула ActionPasswordInput более точная. Обновить ActionInput:
```tsx
const rightPadding =
  effectiveActionCount > 0
    ? `${8 + effectiveActionCount * 22 + Math.max(0, effectiveActionCount - 1) * 4}px`
    : undefined;
```

Не критично — оба работают, но консистентность помогает rev review.

---

### IN-07: `actions_menu` i18n key теперь dead code

**File:** `gui-pro/src/shared/i18n/locales/ru.json:1030-1032` и `en.json:1030-1032`

**Issue:** Ключ `users.actions_menu` («Действия с пользователем» / «User actions») был aria-label для удалённого OverflowMenu trigger. Тест `UsersSection.test.tsx:170-174` явно проверяет, что OverflowMenu НЕ используется (grep `queryByRole("button", { name: i18n.t("users.actions_menu") })` возвращает null). Ключ остался, но больше не используется в source.

**Fix:** Удалить из обоих locales если нет других упоминаний:
```bash
grep -rn "users.actions_menu\|actions_menu" gui-pro/src
```
Если только в тесте, который проверяет отсутствие — можно оставить как «guarding key» (тест использует `i18n.t("users.actions_menu")` для сравнения), либо заменить на inline-строку в тесте.

---

### IN-08: UserConfigModal — auto-focus таймер 250ms магическое число

**File:** `gui-pro/src/components/server/UserConfigModal.tsx:114`

**Issue:** `setTimeout(() => closeButtonRef.current?.focus(), 250)` с магическим числом 250. Это, видимо, соответствует duration ModalPrimitive transition (`duration-200`). Если transition меняется, focus может сломаться.

**Fix:** Использовать константу или requestAnimationFrame пока element не visible:
```tsx
useEffect(() => {
  if (!isOpen) return;
  // Sync with Modal fade-in (duration-200 in Modal.tsx)
  const MODAL_FADE_IN_MS = 250; // slightly > Modal's 200ms
  const timer = setTimeout(() => closeButtonRef.current?.focus(), MODAL_FADE_IN_MS);
  return () => clearTimeout(timer);
}, [isOpen]);
```

Или, что лучше — проложить focus-trap в Modal primitive через prop `autoFocusSelector="[data-modal-initial-focus]"` и добавить `data-modal-initial-focus` на X-button.

---

_Reviewed: 2026-04-17T21:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
