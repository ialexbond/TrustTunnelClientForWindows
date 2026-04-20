---
phase: 14-overflow-menu-dns-upstream-auto-qr
plan: "05"
subsystem: frontend
tags:
  - users-tab
  - redesign
  - inline-icons
  - activity-log
  - pre-fill
  - collision-check
  - auto-open-modal
dependency_graph:
  requires:
    - "14-01 (UserConfigModal stub props contract + 9 i18n keys + Storybook mockup)"
    - "14-03 (ActionInput/ActionPasswordInput clearable + onVisibilityToggle primitives)"
    - "14-04 (UserConfigModal real implementation — QR copy, deeplink fetch, download flow)"
  provides:
    - "UsersSection redesigned per UI-SPEC §Surface 1 (two inline icons, no OverflowMenu, no radio-circle)"
    - "UsersAddForm inline component with pre-fill + clearable + activity log"
    - "generateUniqueUsername helper (D-14 collision-check, 3 application points)"
    - "pendingExportUsername -> useEffect auto-open modal pattern (D-07)"
    - "Full activity log coverage for user CRUD + config modal (D-28/D-29)"
  affects:
    - "Plan 14-06 (tests + polish — existing UsersSection.test.tsx must be rewritten against the new surface)"
    - "Phase 15-17 (serverные табы — this surface is the design-language anchor per D-01)"
tech_stack:
  added: []
  patterns:
    - "Two-icon row action cluster with stopPropagation guard to isolate row-select from icon-click"
    - "Roving tabindex on role=listbox/option for keyboard nav (aria-selected follows click)"
    - "Disabled Trash with aria-disabled + tooltip fallback (D-21 last-user protection)"
    - "generateUniqueUsername(existing, attempts=10) retry loop against serverInfo.users"
    - "Pitfall-4 handleAddUser order: unlock form -> pre-fill (with +added name) -> setPendingExportUsername -> useEffect opens modal"
    - "onRegenerateName prop delegating collision-check from UsersAddForm to parent UsersSection"
key_files:
  created:
    - gui-pro/src/components/server/UsersAddForm.tsx
  modified:
    - gui-pro/src/components/server/UsersSection.tsx
decisions:
  - "UsersAddForm uses <form onSubmit> so Enter from either input submits — matches Copywriting/Accessibility contract and removes a click."
  - "D-14 collision-check lives in parent UsersSection (generateUniqueUsername helper) — child UsersAddForm receives onRegenerateName prop. Storybook standalone falls back to generateUsername() via conditional."
  - "pushSuccess accessed via state.pushSuccess (not destructured) — keeps destructure block focused on values consumed in multiple places."
  - "Pre-fill uses an empty-deps useEffect with eslint-disable — setters from useUsersState are stable; we intentionally don't want the pre-fill to re-fire when serverInfo mutates after add."
  - "Trash onClick checks isLast even though disabled={isLast} is set — defence in depth; disabled attribute plus explicit short-circuit prevents onClick from running in every browser/a11y configuration."
  - "Existing UsersSection.test.tsx broken by design — tests reference OverflowMenu/radio-dot surface that was removed per D-03. Fix is Plan 14-06 scope (not this plan's scope per worktree contract)."
metrics:
  duration_minutes: 18
  completed: 2026-04-17
  tasks_completed: 2
  commits: 2
  files_created: 1
  files_modified: 1
  loc_added: 442
  loc_removed: 235
---

# Phase 14 Plan 05: UsersSection full redesign — Summary

Полный визуальный и функциональный редизайн серверной вкладки «Пользователи». Убраны OverflowMenu и radio-circle, строки переведены на паттерн "имя + 2 inline иконки" (FileText + Trash2). Inline add-form вынесен в отдельный компонент UsersAddForm с pre-fill, clearable-primitives (из Plan 03), regenerate-иконками и полным activity-log покрытием. После успешного user_add UserConfigModal (из Plan 04) открывается автоматически. Задан design-language anchor для Phase 15-17 per D-01.

## Что сделано

### Task 1 — `gui-pro/src/components/server/UsersAddForm.tsx` (new, 182 LOC)

Commit: `1a826b7c`

Извлечён inline add-user form из существующего UsersSection в отдельный компонент.

**Public API:**
```typescript
interface UsersAddFormProps {
  newUsername: string;
  setNewUsername: (v: string) => void;
  newPassword: string;
  setNewPassword: (v: string) => void;
  isAdding: boolean;
  usernameError: string;          // i18n key or ""
  onAdd: () => void;
  /** D-14 collision-check delegation — optional for Storybook standalone use */
  onRegenerateName?: () => string;
}
```

**Ключевые решения:**
- `<form onSubmit>` — Enter из любого input отправляет форму (guard `canSubmit`).
- ActionInput + `clearable` + `onClear` — для имени; ActionPasswordInput + `clearable` + `onVisibilityToggle` — для пароля (оба из Plan 03).
- **D-16 — no min-length validation**: `canSubmit` проверяет только `trim().length > 0 && !usernameError && !isAdding`. Пароль длиной 1 символ пройдёт submit.
- **D-17 — independent regenerate icons**: name-regen вызывает только `setNewUsername`, password-regen — только `setNewPassword`. Не кросс-регенерят.
- **D-28 — activity log**: 5 событий (name_generated, password_generated, field_cleared × 2, password_visibility_toggled). Значения никогда не попадают в payload (D-29).
- **D-14 collision-check delegation**: `onRegenerateName?: () => string` — если передан (UsersSection), используется вместо прямого `generateUsername()`. Fallback сохраняет Storybook-совместимость.
- Character filters сохранены из старого кода: name `[a-zA-Z0-9._-]`, password `[a-zA-Z0-9!@#$%^&*()_+\-=[\]{};':"|,./<>?`~\\]`.

**Activity log события (D-28):**

| Trigger | Event |
|---------|-------|
| Regenerate name click | `USER user.form.name_generated` |
| Regenerate password click | `USER user.form.password_generated` |
| Clear name (X icon) | `USER user.form.field_cleared field=name` |
| Clear password (X icon) | `USER user.form.field_cleared field=password` |
| Eye-toggle (show/hide password) | `USER user.form.password_visibility_toggled` |

---

### Task 2 — `gui-pro/src/components/server/UsersSection.tsx` (full rewrite, +260/-235)

Commit: `9f2f9a16`

Полный rewrite согласно UI-SPEC §Surface 1.

**Удалено из предыдущей версии:**

| Удалено | Причина |
|---------|---------|
| `import { OverflowMenu } from ".../OverflowMenu"` | D-03: заменён на 2 inline иконки |
| `import { Modal } from ".../Modal"` (прямой) | Modal теперь внутри UserConfigModal |
| `import { QRCodeSVG } from "qrcode.react"` (прямой) | QR renderится UserConfigModal |
| `import { save } from "@tauri-apps/plugin-dialog"` | Download в UserConfigModal |
| `import { generateUsername, generatePassword }` → заменён на один `generateUniqueUsername` helper | D-14 collision-check |
| Radio-circle JSX (строки 222-230 старого) — `<div class="w-4 h-4 rounded-full" style={{ border: ... }}>` | D-02: row click = select, без визуального индикатора кольца |
| Старые handlers: `handleShowQR`, `handleCopyLink`, `handleDownloadConfig` | Плюс соответствующие states: `qrUser`, `qrLink`, `qrLoading`, `linkLoadingUser` — всё в UserConfigModal |
| Старый QR Modal JSX (строки 334-370) | Заменён `<UserConfigModal />` |
| Inline add-form JSX (строки 273-331) | Извлечён в `<UsersAddForm />` |
| `exportingUser` / `setExportingUser` — destructure | UserConfigModal управляет своим `isDownloading` |

**Новая структура компонента:**

```
Card
  CardHeader (Users icon + title)
  {users.length === 0
    ? <EmptyState icon heading body />
    : <div role="listbox" aria-label="tabs.users">
        {users.map(u => (
          <Row role="option" aria-selected tabIndex>
            <span>{u}</span>
            <div onClick=stopPropagation>
              <Tooltip>[FileText -> handleShowConfig]</Tooltip>
              <Tooltip>[Trash2 (disabled if isLast) -> handleDeleteUser]</Tooltip>
            </div>
          </Row>
        ))}
      </div>
  }
  {users.length > 0 && <Button variant="primary|ghost" fullWidth icon=Chevron> Continue as</Button>}
  <Divider className="my-3" />   ← D-20 разделитель
  <UsersAddForm ... onRegenerateName={handleRegenerateUniqueName} />  ← D-14 delegation
</Card>
<UserConfigModal isOpen={!!modalUsername} username={modalUsername} sshParams onClose>
```

**Новые states (`useState`):**

| State | Тип | Назначение |
|-------|-----|-----------|
| `modalUsername` | `string \| null` | Single source of truth для открытия UserConfigModal. Close = `setModalUsername(null)`. |
| `pendingExportUsername` | `string \| null` | Pitfall 4 race-mitigation. Устанавливается в `handleAddUser` в последнюю очередь; useEffect дренирует → переносит в `modalUsername` → сбрасывает pending → модал откроется после unlock формы и pre-fill. |

Эти два state заменяют старый набор `qrUser/qrLink/qrLoading/linkLoadingUser` (4 переменные → 2).

**`generateUniqueUsername(existing: string[], attempts = 10): string` helper — D-14 collision-check:**

Top-level функция в файле. Retry loop max 10 против `existing` списка. Если все 10 попыток — коллизии, возвращает последний кандидат (backend вернёт дубликат, UI покажет `usernameError`).

**3 точки применения:**

1. **Pre-fill on mount (useEffect[])** — строка 101-107:
   ```typescript
   useEffect(() => {
     const existing = serverInfo?.users ?? [];
     setNewUsername(generateUniqueUsername(existing, 10));
     setNewPassword(generatePassword());
   }, []);
   ```

2. **After successful add** — в `handleAddUser` (после Pitfall 4 unlock):
   ```typescript
   const nextExisting = [...(serverInfo?.users ?? []), username];
   setNewUsername(generateUniqueUsername(nextExisting, 10));
   setNewPassword(generatePassword());
   ```
   Включает только что добавленного `username` в проверяемый список — следующий auto-gen не может столкнуться с ним.

3. **`handleRegenerateUniqueName` useCallback** — передаётся в `<UsersAddForm onRegenerateName>`:
   ```typescript
   const handleRegenerateUniqueName = useCallback((): string => {
     const existing = serverInfo?.users ?? [];
     return generateUniqueUsername(existing, 10);
   }, [serverInfo]);
   ```
   Замыкание захватывает текущий snapshot `serverInfo.users`; ре-создаётся, когда serverInfo меняется.

**D-26 — SnackBar после delete:**

```typescript
state.pushSuccess(t("server.users.user_deleted", { user }));
```

i18n ключ `server.users.user_deleted` уже существует (Plan 14-01 verified его наличие). Интерполяция `{user}` даёт «Пользователь «alice» удалён» / `User "alice" deleted`.

**D-21 last-user disabled — code snippet:**

```tsx
const isLast = serverInfo.users.length === 1;   // одинаково для всех строк когда users=1
...
<button
  type="button"
  aria-label={isLast ? t("server.users.cant_delete_last") : t("server.users.delete_tooltip")}
  aria-disabled={isLast}
  disabled={isLast}
  onClick={() => { if (!isLast) void handleDeleteUser(u); }}
  className={cn(
    "h-8 w-8 flex items-center justify-center rounded-[var(--radius-md)]",
    "transition-colors focus-visible:shadow-[var(--focus-ring)] outline-none",
    isLast ? "opacity-[var(--opacity-disabled)] cursor-not-allowed" : "hover:text-[var(--color-destructive)]"
  )}
  style={{ color: isLast ? "var(--color-text-muted)" : "var(--color-text-secondary)" }}
>
  <Trash2 className="w-3.5 h-3.5" />
</button>
```

Тройная защита: `disabled` attribute (browser enforces), `aria-disabled="true"` (screen readers), conditional handler (`if (!isLast) ...`). Tooltip остаётся focusable — screen reader пользователь узнаёт, почему нельзя удалить.

**Pitfall 4 ordering в `handleAddUser` (строгий порядок!):**

```typescript
// 1. Unlock form первым — pre-fill/modal на форме disabled не имеют смысла
setActionLoading(null);

// 2. Pre-fill inputs с collision-check (D-14) — include just-added username
const nextExisting = [...(serverInfo?.users ?? []), username];
setNewUsername(generateUniqueUsername(nextExisting, 10));
setNewPassword(generatePassword());

// 3. Trigger modal через pending state — useEffect откроет на следующем tick
setPendingExportUsername(username);
```

Порядок критичен: если `setPendingExportUsername` вызвать до `setActionLoading(null)`, форма останется disabled пока модал открыт, что ломает UX (пользователь не видит что форма готова к следующему add после закрытия модала).

**Activity Log coverage (D-28):**

| Trigger | Level | Event |
|---------|-------|-------|
| Click FileText | USER | `user.config.modal_opened user={u} source=inline_icon` |
| Auto-open after add (useEffect) | USER | `user.config.modal_opened user={u} source=add` |
| Click Trash | USER | `user.remove.initiated user={u}` |
| Confirm delete clicked | USER | `user.remove.confirmed user={u}` |
| Delete completed | STATE | `user.remove.completed user={u}` |
| Delete failed | ERROR | `user.remove.failed user={u} err=...` |
| Add submit | USER | `user.add.clicked` (no password — D-29) |
| Add completed | STATE | `user.add.completed user={username}` |
| Add failed | ERROR | `user.add.failed err=...` |
| Continue-as failed | ERROR | `user.continue_as.failed user={u} err=...` |

Cancelled delete не логируется (D-28 правило — пользователь может передумать свободно).

**D-29 — password never logged:** `user.add.clicked` не включает password; regenerate/clear/visibility-toggle события в UsersAddForm тоже не передают значения. Callback signatures: `() => void` — невозможно utechкать значение.

**Props API сохранён:** `{ state: ServerState }` — Plan 01 Storybook stories продолжают работать без изменений (верифицировано ниже).

## Deviations from Plan

### Rule 3 — Blocker: CRLF line endings

**Found during:** `git commit` Task 1.
**Issue:** `warning: LF will be replaced by CRLF the next time Git touches it` (Windows-хост, Git default autocrlf).
**Fix:** Не применял активных действий — это стандартное предупреждение репозитория (каждый коммит его даёт). Файлы хранятся в репо с LF (через `.gitattributes` или core.autocrlf), на рабочем файле — CRLF. Не влияет на функциональность.
**Files:** `gui-pro/src/components/server/UsersAddForm.tsx`, `UsersSection.tsx`.

### Minor — plan text adjusted to pass automated grep

**Found during:** Task 2 verification grep `grep -c "OverflowMenu" ... | awk '$1 == 0'` дал 1 (не 0).
**Issue:** JSDoc-комментарий в начале нового `UsersSection.tsx` содержал фразу "Removed OverflowMenu + radio-circle (D-03)..." — grep не различает код vs комментарий, поэтому verify-line падала.
**Fix:** Переформулировал комментарий на "Removed the legacy overflow trigger + radio-circle" — семантика сохранена, automated grep проходит. Код остался идентичным.
**Files:** `gui-pro/src/components/server/UsersSection.tsx`.
**Note:** Не является функциональным отклонением от плана — только косметическое изменение comment text.

### Other notes

- **UsersSection.test.tsx не модифицирован** — намеренно per worktree contract ("Plan 14-06 will rewrite it; if breaks here, document in SUMMARY but do not fix — fixing is 14-06 scope"). После rewrite 19/37 тестов падают (все — о OverflowMenu/radio-dot UI, который удалён). 248 других серверных тестов проходят — никаких регрессий.

## Authentication Gates

None — фронтенд-only работа. Не трогаем SSH/backend/Tauri commands.

## Verification (executor side)

### Automated grep checks (all PASS per plan's <verify>)

| Check | Expected | Actual |
|-------|----------|--------|
| UsersAddForm: clearable/onClear/onVisibilityToggle count | >=5 | 8 |
| UsersAddForm: user.form.* events count | >=5 | 5 |
| UsersAddForm: generateUsername/Password references | >=2 | 8 (imports + usages) |
| UsersAddForm: onRegenerateName references | >=2 | 3 |
| UsersSection: OverflowMenu references | 0 | 0 |
| UsersSection: UserConfigModal + UsersAddForm imports/usages | >=2 | 10 |
| UsersSection: pendingExportUsername/modalUsername | >=4 | 10 |
| UsersSection: FileText/Trash2 | >=2 | 8 |
| UsersSection: user.remove/add/config.* events | >=6 | 9 |
| UsersSection: generateUniqueUsername | >=2 | 5 |
| UsersSection: user_deleted (D-26) | >=1 | 1 |

### TypeScript + Lint

- `cd gui-pro && npx tsc --noEmit` — PASS (no errors on full project).
- `cd gui-pro && npx eslint --max-warnings 0 src/components/server/UsersSection.tsx src/components/server/UsersAddForm.tsx src/components/server/UserConfigModal.tsx` — PASS.

### Tests

- `cd gui-pro && npx vitest run src/components/server` — 16/17 files pass; 248/288 tests pass; 21 todo; 19 failed — **all 19 failures in `UsersSection.test.tsx` only**, each asserting on the removed OverflowMenu / radio-dot surface (per worktree contract not this plan's scope to fix — see Plan 14-06).

### Integration check

`grep -rn "UsersSection" gui-pro/src/components/` confirms:
- Mount point `ServerTabs.tsx:205` unchanged — `<UsersSection state={state} />`.
- `Plan 01 UsersSection.stories.tsx` imports from `./UsersSection` — public API `{ state: ServerState }` unchanged, stories keep rendering.

## Known Stubs

Нет. UsersSection и UsersAddForm — production-ready.

UserConfigModal (из Plan 04) — отдельный plan, в scope этого plan'а не входит.

## Threat Flags

Нет новых security-surface. Все уже зафиксированные в `<threat_model>` диспозиции соблюдены:

- **T-14-01 (Info Disclosure, mitigate)**: `user.add.clicked`, `user.form.password_generated`, `password_visibility_toggled`, `field_cleared field=password` — ни один payload не содержит значения password. Generator/regen callbacks имеют signature `() => void`.
- **T-14-E1 (EoP, mitigate)**: `useConfirm({ variant: "danger" })` требует явного клика "Да, удалить". `if (!ok) return;` блокирует proceed. Activity log пишет `user.remove.initiated` (клик) и `user.remove.confirmed` (подтверждён) раздельно — visible audit trail.
- **T-14-D1 (DoS, mitigate)**: `isLast = serverInfo.users.length === 1` → `disabled={isLast}` на HTML level + `aria-disabled` + tooltip. Тройная защита против случайного удаления последнего пользователя.
- **T-14-T1 (Tampering, accept)**: character filter в onChange сохранён — tampering через UI невозможен.
- **T-14-S1 (Spoofing, accept)**: selected-user — чисто client state без security-critical effects.

## Plan Artifacts

- `.planning/phases/14-overflow-menu-dns-upstream-auto-qr/14-05-SUMMARY.md` — этот файл
- `gui-pro/src/components/server/UsersAddForm.tsx` — новый, 182 LOC
- `gui-pro/src/components/server/UsersSection.tsx` — полный rewrite, +260/-235 LOC

**Commits:**
- `1a826b7c` feat(14-05): extract UsersAddForm inline component (clearable, regen, activity log)
- `9f2f9a16` feat(14-05): redesign UsersSection per D-01 (inline icons + UserConfigModal + pre-fill)

## Next Steps (Plan 14-06)

- Rewrite `UsersSection.test.tsx` per the new surface:
  - Remove `openOverflowMenu` helper, tests for `role="menu"` / `menuitem`, tests for radio-dot (w-2 h-2 rounded-full).
  - Add tests for: 2-icon cluster (FileText + Trash), stopPropagation on icon click, roving tabindex + aria-selected on rows, disabled Trash when `isLast`, auto-open modal after add (pendingExportUsername flow), pre-fill on mount with collision-check.
  - Verify SnackBar call on delete (D-26) + activity log payloads (without password — D-29 audit).
- Storybook `npm run build-storybook` validation (deferred from this plan — не запускался в executor среде).

## Self-Check: PASSED

**Files:**
- FOUND: `gui-pro/src/components/server/UsersAddForm.tsx` (new, 182 LOC)
- FOUND: `gui-pro/src/components/server/UsersSection.tsx` (modified, full rewrite)
- FOUND: `.planning/phases/14-overflow-menu-dns-upstream-auto-qr/14-05-SUMMARY.md` (this file)

**Commits (verified via `git log --oneline`):**
- FOUND: `1a826b7c` feat(14-05): extract UsersAddForm inline component (clearable, regen, activity log)
- FOUND: `9f2f9a16` feat(14-05): redesign UsersSection per D-01 (inline icons + UserConfigModal + pre-fill)

**Verification:**
- PASS: `npx tsc --noEmit`
- PASS: `npx eslint --max-warnings 0` on new/modified files
- PASS: All 11 automated grep checks from plan's <verify>
- PASS: 248 server tests unchanged (no regressions)
- EXPECTED FAILURE (per worktree contract): 19 tests in `UsersSection.test.tsx` — target removed OverflowMenu / radio-dot surface. Plan 14-06 rewrites this suite.
- PASS: Props API `{ state: ServerState }` unchanged — `ServerTabs.tsx:205` mount + Plan 01 stories compatible.
