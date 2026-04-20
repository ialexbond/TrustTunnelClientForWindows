---
phase: 05-layout-shell
reviewed: 2026-04-15T12:00:00Z
depth: standard
files_reviewed: 20
files_reviewed_list:
  - gui-pro/src/components/layout/TabNavigation.tsx
  - gui-pro/src/components/ServerSidebar.tsx
  - gui-pro/src/components/ServerTabs.tsx
  - gui-pro/src/components/ControlPanelPage.tsx
  - gui-pro/src/components/server/Fail2banSection.tsx
  - gui-pro/src/components/server/CertSection.tsx
  - gui-pro/src/components/server/ServerStatusSection.tsx
  - gui-pro/src/components/server/DiagnosticsSection.tsx
  - gui-pro/src/components/server/LogsSection.tsx
  - gui-pro/src/components/server/FirewallSection.tsx
  - gui-pro/src/components/server/UsersSection.tsx
  - gui-pro/src/components/server/VersionSection.tsx
  - gui-pro/src/shared/ui/StatusBadge.tsx
  - gui-pro/src/shared/ui/Select.tsx
  - gui-pro/src/shared/ui/EmptyState.tsx
  - gui-pro/src/shared/i18n/locales/ru.json
  - gui-pro/src/shared/i18n/locales/en.json
  - gui-pro/src/shared/ui/StatusBadge.test.tsx
  - gui-pro/src/shared/ui/EmptyState.test.tsx
  - gui-pro/src/shared/ui/Select.test.tsx
findings:
  critical: 0
  warning: 4
  info: 5
  total: 9
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-04-15T12:00:00Z
**Depth:** standard
**Files Reviewed:** 20
**Status:** issues_found

## Summary

Ревью охватывает компоненты shell-слоя (TabNavigation, ServerSidebar, ServerTabs, ControlPanelPage), секции серверной панели (Fail2ban, Cert, ServerStatus, Diagnostics, Logs, Firewall, Users, Version), три переиспользуемых UI-компонента (StatusBadge, Select, EmptyState), файлы локализации и тесты.

Критических проблем не обнаружено. Выявлены четыре предупреждения с риском реального бага: polling-интервал захватывает устаревший closure, небезопасный вызов `clipboard.writeText` без обработки ошибки, непустой таймаут (`setTimeout`) внутри `finally`-блока не отменяется при размонтировании, и потенциальный NaN при парсинге значений jail. Также пять информационных замечаний по качеству кода.

---

## Warnings

### WR-01: Stale closure в polling-интервале ControlPanelPage

**File:** `gui-pro/src/components/ControlPanelPage.tsx:84`

**Issue:** Второй `useEffect` с интервалом 500 мс указывает `creds` в списке зависимостей, что означает: при каждом изменении `creds` интервал пересоздаётся. Внутри обработчика используется переменная `creds` из closure (строка 84: `if (!creds)`). Это само по себе работает, но пересоздание интервала при каждом изменении `creds` создаёт transient-эффект: при быстрых изменениях состояния (подключение/отключение) возможны двойные вызовы `readStoredCredentials()` — один из истёкшего интервала, один из нового. Результат: двойной `setCreds` и `setRefreshKey`, что может вызвать нежелательный двойной ремонт `ServerPanel`.

**Fix:** Использовать `useRef` для хранения актуального значения `creds`, убрать `creds` из зависимостей:

```tsx
const credsRef = useRef(creds);
useEffect(() => { credsRef.current = creds; }, [creds]);

useEffect(() => {
  const interval = setInterval(() => {
    const ts = localStorage.getItem("trusttunnel_control_refresh");
    const lastTs = lastTsRef.current;
    if (ts && ts !== lastTs) {
      lastTsRef.current = ts;
      readStoredCredentials().then((fresh) => {
        if (fresh) { setCreds(fresh); setRefreshKey(k => k + 1); }
        else setCreds(null);
      });
    }
    if (!credsRef.current) {
      readStoredCredentials().then((fresh) => {
        if (fresh) { setCreds(fresh); setRefreshKey(k => k + 1); }
      });
    }
  }, 500);
  return () => clearInterval(interval);
}, []); // нет зависимостей — интервал создаётся один раз
```

---

### WR-02: `navigator.clipboard.writeText` без обработки отказа в LogsSection

**File:** `gui-pro/src/components/server/LogsSection.tsx:65`

**Issue:** `navigator.clipboard.writeText(serverLogs)` вызывается без `await` и без `.catch()`. В Tauri-контексте clipboard API обычно доступен, однако если разрешение будет отозвано или API недоступен (DevTools в фокусе, окно не активно), промис отклонится молча. При этом `setCopied(true)` выставляется безусловно — UI покажет галочку "скопировано", хотя данные не были скопированы.

**Fix:**

```tsx
const handleCopy = async () => {
  try {
    await navigator.clipboard.writeText(serverLogs);
    state.pushSuccess(t("server.logs.copied"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  } catch {
    state.pushSuccess(t("server.logs.copy_failed") /* добавить ключ */, "error");
  }
};
```

---

### WR-03: `setTimeout` внутри `finally` не очищается при размонтировании в CertSection

**File:** `gui-pro/src/components/server/CertSection.tsx:180`

**Issue:** В `handleRenew` внутри `finally`-блока выполняется `await new Promise(r => setTimeout(r, 2000))`. Если компонент размонтируется во время этого ожидания (например, пользователь переключил таб), код продолжает выполняться: вызываются `loadCert()`, `setRenewStatus("")`, `setRenewLoading(false)`, что вызывает предупреждение React "Can't perform state update on unmounted component" и потенциальную ошибку.

**Fix:** Использовать AbortController или проверку mounted-флага:

```tsx
const mountedRef = useRef(true);
useEffect(() => { return () => { mountedRef.current = false; }; }, []);

// В finally:
await new Promise(r => setTimeout(r, 2000));
if (!mountedRef.current) return;
await loadCert();
setRenewStatus("");
setRenewLoading(false);
if (succeeded) state.pushSuccess(t("server.cert.renewed"));
```

---

### WR-04: `parseInt(v) || 0` маскирует ввод "0" в Fail2banSection

**File:** `gui-pro/src/components/server/Fail2banSection.tsx:124`

**Issue:** При редактировании поля `maxretry` используется `parseInt(v) || 0`. Если пользователь вводит `"0"` (ноль попыток — валидное значение для некоторых конфигураций), выражение `parseInt("0") || 0` вернёт `0` правильно, но `parseInt("") || 0` тоже вернёт `0`, не давая пользователю очистить поле перед вводом нового числа. При вводе `"05"` — вернёт `5` без предупреждения. Более серьёзно: если `v` является строкой вроде `"3abc"`, `parseInt` вернёт `3` — молчаливая обрезка входных данных без фидбэка.

**Fix:**

```tsx
onChange={(v) => {
  const num = v === "" ? 0 : parseInt(v, 10);
  if (!isNaN(num)) {
    state.setJailDraft({ ...state.jailDraft, [jail.name]: { ...draft, maxretry: num } });
  }
}}
```

---

## Info

### IN-01: Отсутствующие ключи i18n для ServerTabs — silent fallback

**File:** `gui-pro/src/components/ServerTabs.tsx:33-39`

**Issue:** Компонент использует ключи `tabs.status`, `tabs.users`, `tabs.config`, `tabs.security`, `tabs.tools`, `tabs.danger`, которых нет в `ru.json` и `en.json` в разделе `tabs`. Работает только через `fallback`-строки. Это не баг (fallback корректен), но означает, что локализованные переводы для этих табов не предусмотрены — при добавлении поддержки нового языка эти метки останутся на русском.

**Fix:** Добавить ключи в обе локали или переименовать на существующие ключи (напр., `server.users.title` и т.д.):

```json
// en.json → секция "tabs"
"status": "Status",
"users": "Users",
"config": "Config",
"security": "Security",
"tools": "Tools",
"danger": "Danger Zone"
```

---

### IN-02: Вложенная кнопка внутри кнопки в ServerSidebar

**File:** `gui-pro/src/components/ServerSidebar.tsx:43-74`

**Issue:** Кнопка отключения (строка 67) рендерится внутри другой `<button>` (строка 43). Вложенные интерактивные элементы (`<button>` внутри `<button>`) являются невалидным HTML. Несмотря на `e.stopPropagation()`, скринридеры и некоторые браузеры обрабатывают вложенные кнопки непредсказуемо.

**Fix:** Заменить внешний `<button>` на `<div role="button" tabIndex={0}>` или реализовать иной layout без нарушения HTML-семантики (например, абсолютно позиционированная кнопка disconnect поверх элемента списка).

---

### IN-03: Кнопка отключения в ServerSidebar не имеет обработки клавиатуры

**File:** `gui-pro/src/components/ServerSidebar.tsx:68-73`

**Issue:** Кнопка disconnect появляется только при наведении мыши/фокусе (`opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`). При навигации с клавиатуры `focus-within` на внешнем `<button>` срабатывает корректно, однако при использовании Tab фокус переходит непосредственно на внутреннюю кнопку, минуя внешнюю. Это нарушает ожидаемую модель фокуса.

**Fix:** Добавить `onFocus` на внешний контейнер или убедиться, что порядок фокуса корректен после смены элемента на `<div>`.

---

### IN-04: `_renewStatus` (unused state) в CertSection

**File:** `gui-pro/src/components/server/CertSection.tsx:140`

**Issue:** Состояние `_renewStatus` объявлено с префиксом `_` (подавление TypeScript-предупреждения), сеттер используется в нескольких местах, но переменная нигде не читается в JSX. Это мёртвый код — прогресс обновления сертификата нигде не отображается UI.

**Fix:** Удалить состояние `_renewStatus` и все вызовы `setRenewStatus(...)` если UI не планирует показывать прогресс. Или добавить отображение прогресса в JSX.

---

### IN-05: Дублирующийся ref-callback для triggerRef в Select

**File:** `gui-pro/src/shared/ui/Select.tsx:138-142`

**Issue:** Ручное слияние ref через callback-функцию (строки 138-142) является корректным паттерном, но `triggerRef as React.MutableRefObject<...>` является небезопасным приведением типа. `useDropdownPortal` возвращает ref неизвестного внутреннего типа — если в хуке тип ref изменится, cast `as MutableRefObject` скроет несоответствие.

**Fix:** Убедиться, что `useDropdownPortal` явно возвращает `MutableRefObject<HTMLButtonElement | null>` для `triggerRef`, или использовать `mergeRefs` утилиту вместо ручного cast.

---

_Reviewed: 2026-04-15T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
