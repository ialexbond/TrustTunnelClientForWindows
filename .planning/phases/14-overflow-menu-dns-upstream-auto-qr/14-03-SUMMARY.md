---
phase: 14-overflow-menu-dns-upstream-auto-qr
plan: "03"
subsystem: shared/ui primitives
tags:
  - primitives
  - input
  - clearable
  - activity-log
dependency_graph:
  requires:
    - Input.tsx (clearable reference API)
  provides:
    - "ActionInput primitive with clearable prop"
    - "ActionPasswordInput primitive with clearable + onVisibilityToggle"
  affects:
    - gui-pro/src/components/server/UsersSection.tsx (will adopt clearable in Plan 05)
    - gui-pro/src/components/wizard/AddUserForm.tsx (backward compat only — not changed)
tech_stack:
  added: []
  patterns:
    - "setRefs pattern for forwardRef + internal ref cohabitation"
    - "showClear guard = clearable && value !== undefined && String(value).length > 0"
    - "effectiveActionCount = actions + clearCount → rightPadding"
    - "onVisibilityToggle callback (fires after setVisible) for activity log"
key_files:
  created: []
  modified:
    - gui-pro/src/shared/ui/ActionInput.tsx
    - gui-pro/src/shared/ui/ActionPasswordInput.tsx
    - gui-pro/src/shared/ui/ActionInput.stories.tsx
    - gui-pro/src/shared/ui/ActionPasswordInput.stories.tsx
decisions:
  - "Extend primitives (not wrapper): mirror Input.tsx clearable API for consistency. Planner Q1 recommendation implemented."
  - "aria-label='Clear field' hardcoded English: primitives don't do i18n — matches Input.tsx convention. Consumers wrap with Tooltip for localized UX."
  - "onVisibilityToggle fires AFTER setVisible(!visible): state change is non-blocking; callback is a side effect for activity log only."
  - "Password input clear-icon positioned LEFT of eye-toggle: per UI-SPEC §Surface 3, flex-row visual order left→right is [actions, Clear, Eye]. Eye stays rightmost as the dominant reveal control."
metrics:
  duration: "3m"
  completed: 2026-04-17
---

# Phase 14 Plan 03: ActionInput Primitive Extensions — Summary

Extended `ActionInput` and `ActionPasswordInput` primitives with a `clearable` prop (mirroring existing `Input.tsx` API), added `onVisibilityToggle` callback on the password variant for activity-log wiring, and documented the new states with 5 Storybook stories. Existing public APIs remain untouched; all 5 consumer sites compile without modification.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | ActionInput — add `clearable` + `onClear` props | `e6ee11a6` | `gui-pro/src/shared/ui/ActionInput.tsx` |
| 2 | ActionPasswordInput — add `clearable` + `onClear` + `onVisibilityToggle` | `bb2461a0` | `gui-pro/src/shared/ui/ActionPasswordInput.tsx` |
| 3 | Storybook stories — `WithClearable` for both primitives | `a877ab41` | `gui-pro/src/shared/ui/ActionInput.stories.tsx`, `gui-pro/src/shared/ui/ActionPasswordInput.stories.tsx` |

---

## Task 1 — ActionInput.tsx

**Diff summary (60 insertions, 6 deletions):**

- Added imports: `useRef` from React, `X` from `lucide-react`.
- Extended `ActionInputProps` interface:
  - `clearable?: boolean` — when true and `value.length > 0`, X icon is rendered.
  - `onClear?: () => void` — optional custom clear handler; defaults to calling `onChange({ target: { value: "" } })`.
- Introduced `internalRef` + `setRefs` to cohabitate with forwarded `ref` (pattern lifted from `Input.tsx` lines 32, 65-69).
- Added `showClear` guard that requires `clearable && value !== undefined && String(value).length > 0` — matches `Input.tsx` semantics.
- `handleClear` handler: calls `onClear` if provided, else synthesises an empty `ChangeEvent` for `onChange`, then focuses the input.
- Replaced single `actionCount` calc with `effectiveActionCount = actionCount + clearCount`; `rightPadding` now accounts for the X slot (Pitfall 3 mitigation — prevents text overlap with icon cluster).
- Render block: X-button is injected BEFORE `actions.map(...)` inside the `.absolute.right-2.flex` cluster, so visual left→right order is `[Clear, ...actions]`. Per UI-SPEC §Surface 3 for name input, the expected right-to-left visual order is `Regenerate (rightmost) → Clear`, which aligns with the flex-row layout where the first child renders leftmost.
- Preserved existing public props: `label`, `description`, `leftIcon`, `actions`, `error`, `helperText`, `fullWidth`, all `InputHTMLAttributes`.
- `aria-label="Clear field"` hardcoded in English following project convention (primitives are locale-agnostic; consumers wrap with `<Tooltip>` for localised discoverability).

**Verification:**
- `cd gui-pro && npx tsc --noEmit` — no errors (full project).
- ESLint `--max-warnings 0` — clean on modified file.

---

## Task 2 — ActionPasswordInput.tsx

**Diff summary (82 insertions, 8 deletions):**

- Added imports: `useRef` from React, `X` from `lucide-react`.
- Extended `ActionPasswordInputProps` interface:
  - `clearable?: boolean`
  - `onClear?: () => void`
  - `onVisibilityToggle?: () => void` — fires after `setVisible(!visible)` to support D-28 `user.form.password_visibility_toggled` activity log (used by Plan 05 add-user form).
- Added `setRefs` forwarding pattern (same as ActionInput).
- `showClear`, `handleClear` — identical semantics to ActionInput.
- New `handleVisibilityClick` wraps existing `setVisible(!visible)` and then calls `onVisibilityToggle?.()`. Keeps visibility change non-blocking regardless of callback presence.
- Replaced rightPadding formula:
  - **Before:** `${8 + (1 + actionCount) * 22 + actionCount * 4}px` (eye assumed always present, gap between icons counted as `actionCount * 4`).
  - **After:** `${8 + totalIconCount * 22 + Math.max(0, totalIconCount - 1) * 4}px` where `totalIconCount = 1 + actionCount + clearCount`. Math.max guards the single-icon case (no gap needed).
- Render block — visual left→right order: `actions → Clear (if showClear) → Eye (always)`. This implements UI-SPEC §Surface 3 password-input cluster order: `[Regenerate, Clear, Eye]` where Eye stays as the rightmost control (dominant reveal affordance).
- Preserved existing public props: `label`, `error`, `helperText`, `showLockIcon`, `actions`, all `InputHTMLAttributes` except `type`.

**Verification:**
- `cd gui-pro && npx tsc --noEmit` — clean.
- ESLint `--max-warnings 0` — clean.
- `PasswordInput.test.tsx` — 9/9 green (sanity check on sibling primitive).

---

## Task 3 — Storybook Stories

**`ActionInput.stories.tsx`** (68 insertions):
- New imports: `useState` from React, `Shuffle` from `lucide-react`.
- `WithClearable` — interactive story, initial value `"some-username"`, demonstrates X appearing + disappearing on clear.
- `WithClearableAndActions` — interactive story combining `clearable` with a Regenerate action button, mirrors the intended Plan 05 add-user name field layout.
- `ClearableEmpty` — static args story, verifies X is **not** rendered when `value=""` (documents the guard behaviour).

**`ActionPasswordInput.stories.tsx`** (52 insertions):
- New imports: `useState` from React, `Shuffle` from `lucide-react`.
- `WithClearable` — interactive story with `clearable` + `onVisibilityToggle` callback wired up (empty handler for demo).
- `WithClearableAndRegenerate` — interactive story combining all three: Regenerate action (random 16-char password), Clear, Eye-toggle. `showLockIcon={false}` to match Plan 05 inline form styling.

**Verification:**
- `cd gui-pro && npx tsc --noEmit` — clean (no TS errors on `.stories.tsx`).
- `grep -c WithClearable` → 2 occurrences each file (one import-like reference in autodoc + one `export const`).

---

## Backward Compatibility

All existing callers compile without source changes:

| Consumer | File | Uses | Impact |
|----------|------|------|--------|
| UsersSection | `gui-pro/src/components/server/UsersSection.tsx` | `ActionInput`, `ActionPasswordInput` via existing `actions` API | none — new props are optional |
| Wizard AddUserForm | `gui-pro/src/components/wizard/AddUserForm.tsx` | `ActionPasswordInput` | none |
| Wizard test | `gui-pro/src/components/wizard/FoundStep.test.tsx` | references primitives | none |
| Primitives barrel | `gui-pro/src/shared/ui/index.ts` | re-exports | none |
| Existing stories | `ActionInput.stories.tsx` / `ActionPasswordInput.stories.tsx` | `Default`, `WithAction`, `WithError`, `Disabled`, etc. | none — preserved verbatim |

Test regression suite:
- `Input.test.tsx` — 6/6 passed.
- `PasswordInput.test.tsx` — 9/9 passed.
- `UsersSection.test.tsx` — 78/78 passed.
- `FoundStep.test.tsx` — 17/17 passed.

**Total: 110/110 passed on consumer + sibling primitive suites. No regressions.**

---

## Deviations from Plan

None — plan executed exactly as written.

Minor refinement (not a deviation): the plan proposed `${8 + (1 + actionCount + clearCount) * 22 + (actionCount + clearCount) * 4}px` for ActionPasswordInput rightPadding. I adopted the mathematically equivalent form `${8 + totalIconCount * 22 + Math.max(0, totalIconCount - 1) * 4}px` with an explicit `totalIconCount` intermediate variable — cleaner reading and explicit guard for the zero-gap case when only the mandatory eye icon is present. Functional identity preserved for all input counts (1→1 icon, 2→2 icons, 3→3 icons, 4→4 icons).

---

## Authentication Gates

None — purely frontend primitive extension with no external auth dependencies.

---

## Activity Log Readiness

The `onVisibilityToggle` callback completes the wiring pipeline for D-28. Plan 05 (UsersSection.tsx rewrite) will consume it as:

```tsx
<ActionPasswordInput
  clearable
  onClear={() => { activityLog("USER", "user.form.field_cleared field=password"); setNewPassword(""); }}
  onVisibilityToggle={() => activityLog("USER", "user.form.password_visibility_toggled")}
  /* ... */
/>
```

D-29 (password value never logged) is upheld: the callback is side-effect only, receives no arguments, does not expose the current value.

---

## Known Stubs

None. All additions are fully functional primitives; no placeholder UI or mock wiring introduced.

---

## Threat Flags

None. No new network endpoints, auth paths, or file-access surfaces introduced. The new callbacks (`onClear`, `onVisibilityToggle`) are pure side-effect hooks that do not receive or emit sensitive data.

Existing threat-model dispositions (STRIDE §T-14-I1/I2/I3 from PLAN.md) are upheld:
- **T-14-I1 (accept)**: eye-toggle callback carries no password value — verified by signature `() => void`.
- **T-14-I2 (mitigate)**: `onClear` callback does not return cleared value — verified by signature `() => void`.
- **T-14-I3 (mitigate)**: `effectiveActionCount` / `totalIconCount` account for `showClear` in rightPadding — verified in both files.

---

## Self-Check: PASSED

**Files verified:**
- `gui-pro/src/shared/ui/ActionInput.tsx` — FOUND (clearable/showClear/handleClear/effectiveActionCount present)
- `gui-pro/src/shared/ui/ActionPasswordInput.tsx` — FOUND (clearable/onVisibilityToggle/showClear/handleClear/handleVisibilityClick/totalIconCount present)
- `gui-pro/src/shared/ui/ActionInput.stories.tsx` — FOUND (WithClearable / WithClearableAndActions / ClearableEmpty exports)
- `gui-pro/src/shared/ui/ActionPasswordInput.stories.tsx` — FOUND (WithClearable / WithClearableAndRegenerate exports)

**Commits verified:**
- `e6ee11a6` — FOUND (ActionInput clearable)
- `bb2461a0` — FOUND (ActionPasswordInput clearable + onVisibilityToggle)
- `a877ab41` — FOUND (Storybook stories)

**Success criteria:**
- [x] ActionInput принимает `clearable` + `onClear`
- [x] ActionPasswordInput принимает `clearable` + `onClear` + `onVisibilityToggle`
- [x] rightPadding корректно учитывает clearable (effectiveActionCount / totalIconCount)
- [x] Eye-toggle вызывает `onVisibilityToggle()` callback после setVisible
- [x] X-иконка появляется только когда `value.length > 0` (ClearableEmpty story verifies)
- [x] 2+ новые stories на каждый компонент
- [x] Существующие 5 мест использования работают без изменений (typecheck + tests green)
- [x] `npm run typecheck` проходит
