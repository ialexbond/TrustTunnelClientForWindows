---
phase: 05-layout-shell
plan: "03"
subsystem: design-system-i18n
tags: [i18n, components, rust, sanitize, locale]
one_liner: "i18n-aware StatusBadge/Select/EmptyState via useTranslation; sanitize() multi-occurrence verified by test suite (D-17, D-18)"
dependency_graph:
  requires: [05-01, 05-02]
  provides:
    - i18n-compliant StatusBadge (D-17)
    - i18n-compliant Select (D-17)
    - i18n-compliant EmptyState (D-17)
    - sanitize() multi-occurrence confirmed (D-18)
  affects:
    - gui-pro/src/shared/ui/StatusBadge.tsx
    - gui-pro/src/shared/ui/Select.tsx
    - gui-pro/src/shared/ui/EmptyState.tsx
    - gui-pro/src/shared/i18n/locales/ru.json
    - gui-pro/src/shared/i18n/locales/en.json
tech_stack:
  added: []
  patterns:
    - useTranslation() hook for component-level i18n
    - t("key", "fallback") pattern for safe defaults
    - resolved* local variables for i18n-resolved props
key_files:
  created: []
  modified:
    - gui-pro/src/shared/ui/StatusBadge.tsx
    - gui-pro/src/shared/ui/Select.tsx
    - gui-pro/src/shared/ui/EmptyState.tsx
    - gui-pro/src/shared/i18n/locales/ru.json
    - gui-pro/src/shared/i18n/locales/en.json
    - gui-pro/src/shared/ui/StatusBadge.test.tsx
    - gui-pro/src/shared/ui/EmptyState.test.tsx
    - gui-pro/src/shared/ui/Select.test.tsx
decisions:
  - "D-17 closed: StatusBadge/Select/EmptyState use useTranslation — no hardcoded Russian strings"
  - "D-18 closed: sanitize() loop+search_from pattern verified by all 6 logging tests"
  - "Tests updated to use English locale strings (i18n fallback in test env = en)"
metrics:
  duration_minutes: 10
  completed_date: "2026-04-15"
  tasks_completed: 2
  files_modified: 8
  commits: 1
---

# Phase 05 Plan 03: Design-System i18n Cleanup Summary

**One-liner:** i18n-aware StatusBadge/Select/EmptyState via useTranslation; sanitize() multi-occurrence verified by test suite (D-17, D-18)

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | StatusBadge + Select + EmptyState i18n + locale files (D-17) | 838db224 | StatusBadge.tsx, Select.tsx, EmptyState.tsx, ru.json, en.json + 3 test files |
| 2 | Verify sanitize() multi-occurrence fix (D-18) | — (no code changes needed) | logging.rs unchanged |

## What Was Built

### Task 1 — i18n Component Cleanup (D-17)

**StatusBadge.tsx:**
- Added `import { useTranslation } from "react-i18next"`
- Removed `defaultLabels` constant (hardcoded Russian: "Подключено", "Отключено", etc.)
- Added `const { t } = useTranslation()` inside function
- `displayLabel = label ?? t(\`status.${resolvedVariant}\`)` — uses existing locale keys

**Select.tsx:**
- Added `import { useTranslation } from "react-i18next"`
- Removed `placeholder = "Выберите..."` destructuring default
- Added `const resolvedPlaceholder = placeholder ?? t("select.placeholder", "Выберите...")`
- JSX: `{selectedLabel || resolvedPlaceholder}`

**EmptyState.tsx:**
- Added `import { useTranslation } from "react-i18next"`
- Removed `heading = "Ничего нет"` and `body = "Здесь появятся..."` destructuring defaults
- Added `resolvedHeading` and `resolvedBody` via `t()` with same fallback strings
- JSX uses `{resolvedHeading}` and `{resolvedBody}`

**ru.json / en.json — new keys added:**
```json
"select": { "placeholder": "Выберите..." / "Select..." },
"empty": { "heading": "Ничего нет" / "Nothing here",
           "body": "Здесь появятся элементы..." / "Items will appear after adding." }
```

### Task 2 — sanitize() Verification (D-18)

`cargo test --lib -- logging::tests` — all 6 tests pass:
- `sanitize_replaces_all_occurrences` — ok
- `sanitize_handles_toml_colon_equals_patterns` — ok
- `sanitize_all_sensitive_keys` — ok
- `sanitize_case_insensitive` — ok
- `sanitize_handles_empty_and_no_match` — ok
- `sanitize_quoted_value_boundaries` — ok

No code changes needed. D-18 was already implemented via `loop + search_from` pattern (lines 30-59 of logging.rs).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated StatusBadge, EmptyState, Select tests to use i18n-resolved strings**
- **Found during:** Task 1 verification (vitest run)
- **Issue:** Tests expected hardcoded Russian strings ("Подключено", "Отключено", "Ничего нет", "Выберите..."), but i18n in test environment uses `en` as default language (via `navigator.language` fallback), so `t()` returns English locale values
- **Fix:** Updated test assertions to use English locale values ("Connected", "Disconnected", "Nothing here", "Select...", etc.) — these are the canonical values returned by i18n in test env
- **Files modified:** StatusBadge.test.tsx, EmptyState.test.tsx, Select.test.tsx
- **Commit:** 838db224 (included in same task commit)

## Pre-existing Test Failures (Out of Scope)

The following tests were failing BEFORE our changes and remain so:

1. **`src/shared/ui/Section.test.tsx`** — 2 tests (collapsible toggle, defaultOpen=false): pre-existing failure, not caused by this plan
2. **`src/components/routing/ProcessFilterSection.test.tsx`** — flaky tests that pass in isolation but occasionally fail in full suite run: pre-existing race condition, not caused by this plan

Both categories confirmed by running the full test suite with git-stashed changes.

## Known Stubs

None — all i18n keys are wired to real locale JSON files loaded at runtime.

## Threat Flags

None — locale JSON files are bundled at build time (T-05-07 accepted), fallback strings are hardcoded in source (T-05-08 accepted), sanitize() verified to mask all occurrences (T-05-06 mitigated).

## Self-Check: PASSED

Files exist:
- gui-pro/src/shared/ui/StatusBadge.tsx — FOUND
- gui-pro/src/shared/ui/Select.tsx — FOUND
- gui-pro/src/shared/ui/EmptyState.tsx — FOUND
- gui-pro/src/shared/i18n/locales/ru.json — FOUND
- gui-pro/src/shared/i18n/locales/en.json — FOUND

Commits exist:
- 838db224 — FOUND (feat(05-03): i18n StatusBadge, Select, EmptyState — close D-17)

Acceptance criteria:
- StatusBadge contains `useTranslation` — YES
- StatusBadge contains `t(\`status.${resolvedVariant}\`)` — YES
- StatusBadge does NOT contain "Подключено" — YES
- StatusBadge does NOT contain `defaultLabels` — YES
- Select contains `useTranslation` — YES
- Select contains `t("select.placeholder"` — YES
- Select does NOT contain `placeholder = "Выберите..."` as default — YES
- EmptyState contains `useTranslation` — YES
- EmptyState does NOT contain `heading = "Ничего нет"` as default — YES
- EmptyState contains `t("empty.heading"` — YES
- ru.json contains `"select"` section with `"placeholder": "Выберите..."` — YES
- en.json contains `"select"` section with `"placeholder": "Select..."` — YES
- `cargo test --lib -- sanitize_replaces_all_occurrences` passes — YES
- All 6 logging sanitize tests pass — YES
