---
phase: 14-overflow-menu-dns-upstream-auto-qr
plan: 01
subsystem: frontend
tags: [storybook, i18n, mockup-first, users-tab]
dependency_graph:
  requires: []
  provides:
    - "Screens/UsersSection storybook mockup (10 states)"
    - "Screens/UserConfigModal storybook mockup (5 states)"
    - "UserConfigModal props contract (stub — Plan 04 wires internals)"
    - "9 new i18n keys (parity across ru/en)"
  affects:
    - "Plan 04 (UserConfigModal real implementation)"
    - "Plan 05 (UsersSection full rewrite — stories defend the visual contract)"
tech_stack:
  added: []
  patterns:
    - "createMockServerState() helper — stub every ServerState slice with noop setters, cast `as unknown as ServerState`"
    - "SnackBarProvider + ConfirmDialogProvider decorator stack for screen-level stories"
    - "Storybook-only escape-hatch props (`_deeplinkOverride`, `_forceLoading`, `_forceError`) kept out of production call sites"
    - "data-theme=\"light\" on wrapper div to opt a single story into the light palette"
key_files:
  created:
    - gui-pro/src/components/server/UsersSection.stories.tsx
    - gui-pro/src/components/server/UserConfigModal.tsx
    - gui-pro/src/components/server/UserConfigModal.stories.tsx
  modified:
    - gui-pro/src/shared/i18n/locales/ru.json
    - gui-pro/src/shared/i18n/locales/en.json
decisions:
  - "Добавлены 9 i18n ключей дословно из §Copywriting Contract — без перефразировки."
  - "UserConfigModal реализован как минимальный визуальный stub: статический QR + deeplink input + Download кнопка + X close. Логика invoke/clipboard/save откладывается на Plan 04."
  - "Debug-props (_deeplinkOverride/_forceLoading/_forceError) оставлены в итоговой сигнатуре как Storybook-only helpers — Plan 04 их сохранит для тестируемости, production code их никогда не передаёт."
  - "LightTheme stories используют `data-theme=\"light\"` на wrapper div вместо storybook-addon-themes globals: совместимо с существующей настройкой preview.ts и не требует изменения конфига аддона."
  - "Избыточные eslint-disable (react-refresh/only-export-components) удалены — проектный ESLint не срабатывает на default-export meta Storybook."
metrics:
  duration_minutes: 35
  completed: 2026-04-17
  tasks_completed: 3
  commits: 3
  files_created: 3
  files_modified: 2
  i18n_keys_added: 9
  stories_added: 15
---

# Phase 14 Plan 01: Storybook mockup + i18n keys Summary

Storybook-first макет для Users-таба Phase 14: 15 screen-level stories (10 UsersSection + 5 UserConfigModal), минимальный stub UserConfigModal с целевой props-сигнатурой, и 9 новых i18n ключей в обоих locales. Пользователь теперь может запустить `npm run storybook` и визуально утвердить желаемое состояние перед Plan 04/05 implementation.

## Что сделано

### Task 1: i18n ключи (9 новых)

Добавлены в обеих locales (`ru.json` + `en.json`) с сохранением parity. Тексты взяты дословно из `14-UI-SPEC.md §Copywriting Contract`.

**В секцию `server.users`:**
| Ключ | Русский | English |
|------|---------|---------|
| `show_config_tooltip` | Показать конфиг | Show config |
| `qr_copied` | QR-код скопирован | QR code copied |
| `qr_click_to_copy` | QR-код — нажмите, чтобы скопировать изображение | QR code — click to copy image |
| `deeplink_aria` | Deeplink для подключения | Connection deeplink |
| `copy_deeplink_tooltip` | Скопировать ссылку | Copy link |
| `download_config` | Скачать файл | Download file |

**В секцию `common`:**
| Ключ | Русский | English |
|------|---------|---------|
| `clear_field` | Очистить поле | Clear field |
| `show_password` | Показать пароль | Show password |
| `hide_password` | Скрыть пароль | Hide password |

**Верификация:** `node -e` проверяет все 9 ключей в обеих locales, JSON валиден.

**Коммит:** `f52633ad`

### Task 2: `UsersSection.stories.tsx` — 10 screen-level stories

Путь: `gui-pro/src/components/server/UsersSection.stories.tsx`
Title: `Screens/UsersSection`

Работает с текущей реализацией `UsersSection` (через props `state={state}`), Plan 05 переработает внутренности — stories защищены API, не внутренностью.

Встроенный helper `createMockServerState(overrides)` полностью покрывает все slice возвращаемого `ServerState` (core + users + versions + logs + diagnostics + dangerZone + helpers + optimistic + props pass-through), используя no-op стабы. Используется cast `as unknown as ServerState` по паттерну из `ServerTabs.stories.tsx`.

**Decorator stack:** `SnackBarProvider` → `ConfirmDialogProvider` → обёртка `div{maxWidth:560,bg:primary,padding:16}`.

**10 Stories:**

| Story | Демонстрирует |
|-------|---------------|
| `Empty` | `users.length === 0` — EmptyState + add form всегда виден |
| `SingleUser` | Trash disabled (D-21: нельзя удалить последнего) |
| `MultipleUsers` | Обычный список без selection |
| `SelectedUser` | `selectedUser="bold-eagle42"` — accent-tint-08 фон + активная Continue-as CTA |
| `LongUsername` | Имя 50+ символов → ellipsis truncation |
| `AddFormPrefilled` | Pre-fill inputs (D-13) с сгенерированными creds |
| `AddInProgress` | `actionLoading="add_user"` — inputs disabled, button spinner |
| `PasswordVisible` | Предзаполненный пароль для демонстрации eye-toggle |
| `AddError` | `usernameError="server.users.username_exists"` — inline error |
| `LightTheme` | Тот же layout под `data-theme="light"` wrapper |

**Коммит:** `fb1b811a`

### Task 3: `UserConfigModal.tsx` stub + `UserConfigModal.stories.tsx` — 5 stories

#### Stub компонент

Путь: `gui-pro/src/components/server/UserConfigModal.tsx`

**Назначение:** Предоставить стабильную props-сигнатуру и статический визуальный шелл для Storybook mockup 14-01. Plan 04 заменит внутренности реальным invoke()/clipboard/save() flow, не меняя публичную сигнатуру.

**Что рендерит stub:**
- X close button (top-right, absolute) — auto-focus через 250ms после open (pattern из Pitfall в 14-PATTERNS)
- 240×240 кликабельный `QRCodeSVG` (клик в stub ничего не делает — Plan 04 привяжет copy-image)
- Caption `server.export.scan_qr` под QR
- `<input readOnly>` с deeplink (mock placeholder или `_deeplinkOverride`) + inline Copy button
- Primary `<Button variant="primary" fullWidth icon={Download}>` с текстом `server.users.download_config`

**Props сигнатура** (стабильна от Plan 01 до Plan 04):
```typescript
{
  isOpen: boolean
  username: string | null
  sshParams: { host, port: number, user, password, keyPath? }
  onClose: () => void
  // Storybook-only:
  _deeplinkOverride?: string
  _forceLoading?: boolean
  _forceError?: string
}
```

Production code всегда передаёт только первые 4 поля. Debug props оставлены в финальной сигнатуре, чтобы Plan 04 сохранил их для тестируемости, но они никогда не используются production call sites.

#### Stories файл

Путь: `gui-pro/src/components/server/UserConfigModal.stories.tsx`
Title: `Screens/UserConfigModal`
Decorator: `SnackBarProvider` + `div{minHeight:100vh,bg:primary}` (layout `fullscreen` чтобы backdrop Modal-а занял всю виртуальную область).

**5 Stories:**

| Story | Демонстрирует |
|-------|---------------|
| `Default` | Полный layout: QR + deeplink + Download + X close, `_deeplinkOverride="tt://example.com/config?..."` |
| `Loading` | `_forceLoading={true}` — спиннер центрирован |
| `Error` | `_forceError="Не удалось получить deeplink..."` — текст ошибки |
| `LongDeeplink` | 400-символьный токен — проверка truncation в input |
| `LightTheme` | Default-контент под `data-theme="light"` wrapper |

**Коммит:** `6a5e79ca`

## Пути артефактов

- `.planning/phases/14-overflow-menu-dns-upstream-auto-qr/14-01-SUMMARY.md` — этот файл
- `gui-pro/src/components/server/UsersSection.stories.tsx` (+308 строк, новый)
- `gui-pro/src/components/server/UserConfigModal.tsx` (+158 строк, новый stub)
- `gui-pro/src/components/server/UserConfigModal.stories.tsx` (+115 строк, новый)
- `gui-pro/src/shared/i18n/locales/ru.json` (+9 строк)
- `gui-pro/src/shared/i18n/locales/en.json` (+9 строк)

## Verification

- [x] `npx tsc --noEmit` — чисто, без ошибок
- [x] ESLint `--max-warnings 0` на новых файлах — 0 errors, 0 warnings
- [x] 9 i18n ключей проверены в обеих locales через `node -e JSON.parse(...) + path traversal`
- [x] 10 stories в `UsersSection.stories.tsx` (`awk` подсчёт export const)
- [x] 5 stories в `UserConfigModal.stories.tsx` (`awk` подсчёт export const)
- [x] Tauri invoke mocks (`.storybook/tauri-mocks/`) уже подключены — SSH-bound действия резолвятся безопасно
- [x] Provider stack в декораторе: `SnackBarProvider` + `ConfirmDialogProvider` (для UsersSection), `SnackBarProvider` (для UserConfigModal)

## Deviations from Plan

### Corrections applied

**1. [Rule 3 — Blocker] Plan суггестит `vi.fn()` для моков, но ESLint/TS не требуют их**
- **Found during:** Task 2 mock setup
- **Issue:** Импорт `import { vi } from "vitest"` в Storybook-файлах создаёт ненужную зависимость от test runner в bundle и лишний import.
- **Fix:** Заменил `vi.fn()` на локальные `noop` / `asyncNoop` функции — точно тот же эффект (stub handlers), без зависимости от vitest.
- **Files modified:** `gui-pro/src/components/server/UsersSection.stories.tsx`
- **Commit:** `fb1b811a`

**2. [Rule 2 — Lint cleanup] Убраны избыточные eslint-disable директивы**
- **Found during:** Task 3 `npx eslint --max-warnings 0` проверка
- **Issue:** `/* eslint-disable react-refresh/only-export-components */` в начале stories-файлов помечен ESLint как «unused directive» (правило не срабатывает на default-export meta).
- **Fix:** Удалены директивы из обоих stories файлов.
- **Files modified:** `gui-pro/src/components/server/UsersSection.stories.tsx`, `gui-pro/src/components/server/UserConfigModal.stories.tsx`
- **Commit:** `6a5e79ca`

### Interpretation of ambiguous guidance

**3. Размещение новых `server.users.*` ключей**
- Плановый action говорит «добавить после `empty_body` (строка 630)». `empty_body` — последний ключ секции `server.users`, поэтому буквальное «после» означает нарушение закрывающей `}`. Добавил новые ключи **после** `empty_body`, **до** закрывающей скобки секции — единственный валидный вариант, совместимый с JSON.

**4. `sshParams` shape в mock**
- `ServerTabs.stories.tsx` mock использует устаревший shape `{ host, port: "22", username, authMethod, password }`, но актуальный `useServerState.ts` возвращает `{ host, port: number, user, password, keyPath? }` (строки 92-101). Использовал актуальный shape — мой mock типобезопасен относительно `ServerState`. Старый mock в ServerTabs.stories не трогал — out of scope.

## Known Stubs

`UserConfigModal.tsx` — **намеренный Plan-01 stub**. Текущее поведение:
- QR button не копирует изображение (Plan 04 подключит `navigator.clipboard.write + ClipboardItem`).
- Copy icon рядом с deeplink input не копирует текст (Plan 04 подключит `clipboard.writeText`).
- Download button не скачивает файл (Plan 04 подключит `fetch_server_config` + `save()` dialog).
- Deeplink в production path показывает статический placeholder `tt://example.com/config?user={name}&token=placeholder` (Plan 04 заменит на реальный `invoke("server_export_config_deeplink")`).

**Stub допустим и планируется:** его цель — дать Plan 04 стабильную entry точку + Storybook уже может показать целевой визуал. Планы интеграции stub → real — Plan 04 scope.

## Checkpoint

Plan explicitly требовал manual Storybook review checkpoint в success_criteria:
> **CHECKPOINT**: User вручную запускает `npm run storybook` и утверждает визуальный mockup перед выполнением Plan 05.

Этот checkpoint находится за пределами autonomy executor-а (plan `autonomous: true`, `wave: 1`, не содержит `type="checkpoint:*"` в задачах) — review происходит в orchestrator-слое после merge этого worktree. Executor отсечку не вызывает.

## Next steps (Plan 04, 05)

- **Plan 04** (UserConfigModal real implementation):
  - Заменить stub внутренности на реальный flow: `invoke("server_export_config_deeplink")` с loading/error states, `navigator.clipboard.write([new ClipboardItem])` для QR image copy, `save()` + `fetch_server_config` + `copy_file` для Download.
  - Сохранить `_deeplinkOverride` / `_forceLoading` / `_forceError` как debug props (не удалять — storybook stories из 14-01 должны продолжать работать).
  - Активировать test-suite для модала (поведение backdrop/escape/X, clipboard path, error banner).

- **Plan 05** (UsersSection full rewrite):
  - Переработать UsersSection: убрать OverflowMenu + radio-circle, добавить 2 inline icon buttons (FileText + Trash), inline add form с ActionInput/ActionPasswordInput + clearable, integrate UserConfigModal (оба триггера: FileText click + auto-after-add).
  - Stories из 14-01 остаются без изменений — они защищают public contract `<UsersSection state={state}/>`.

## Self-Check: PASSED

**Files:**
- FOUND: gui-pro/src/components/server/UsersSection.stories.tsx
- FOUND: gui-pro/src/components/server/UserConfigModal.tsx
- FOUND: gui-pro/src/components/server/UserConfigModal.stories.tsx
- FOUND: gui-pro/src/shared/i18n/locales/ru.json (modified)
- FOUND: gui-pro/src/shared/i18n/locales/en.json (modified)

**Commits (verified via `git log`):**
- FOUND: f52633ad feat(14-01): add 9 i18n keys for Users tab redesign and UserConfigModal
- FOUND: fb1b811a feat(14-01): add 10 UsersSection screen-level stories (mockup-first)
- FOUND: 6a5e79ca feat(14-01): add UserConfigModal stub + 5 mockup stories

**Verification:**
- PASS: npx tsc --noEmit
- PASS: npx eslint --max-warnings 0 (новые файлы)
- PASS: 9/9 i18n keys present in both locales
- PASS: 10 exports in UsersSection.stories.tsx
- PASS: 5 exports in UserConfigModal.stories.tsx
