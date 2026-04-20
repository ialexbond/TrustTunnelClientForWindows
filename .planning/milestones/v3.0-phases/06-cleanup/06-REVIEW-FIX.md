---
phase: 06-cleanup
fixed_at: 2026-04-15T12:30:00Z
review_path: .planning/phases/06-cleanup/06-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 6: Code Review Fix Report

**Fixed at:** 2026-04-15T12:30:00Z
**Source review:** .planning/phases/06-cleanup/06-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3
- Fixed: 3
- Skipped: 0

## Fixed Issues

### WR-01: ConfigPanel still uses hardcoded Tailwind color classes (not tokenized)

**Files modified:** `gui-pro/src/components/ConfigPanel.tsx`, `gui-pro/src/shared/i18n/locales/ru.json`, `gui-pro/src/shared/i18n/locales/en.json`
**Commit:** db767fc1
**Applied fix:** Replaced all hardcoded Tailwind color utilities (text-indigo-400, text-gray-*, bg-white/5, border-white/10, focus:border-indigo-500/50, focus:ring-indigo-500/25, placeholder-gray-600) with CSS design tokens via inline styles (--color-accent-interactive, --color-text-secondary, --color-text-muted, --color-input-bg, --color-input-border, --color-text-primary, --color-border). Added `useTranslation()` import and replaced 4 hardcoded Russian strings with i18n keys (configPanel.title, configPanel.configFile, configPanel.selectFile, configPanel.logLevel) in both ru.json and en.json.

### WR-02: `backgroundColor: "none"` is invalid CSS in StepBar and RuleEntryRow

**Files modified:** `gui-pro/src/components/wizard/StepBar.tsx`, `gui-pro/src/components/routing/RuleEntryRow.tsx`
**Commit:** 96e0b083
**Applied fix:** Replaced `backgroundColor: "none"` with `backgroundColor: "transparent"` in StepBar.tsx (line 57, active step indicator) and RuleEntryRow.tsx (lines 23-24, ip/cidr badge background). `"none"` is not a valid CSS value for background-color; `"transparent"` is the correct keyword for no visible background.

### WR-03: Wizard EndpointStep uses Tailwind !important overrides to fight .wizard-input specificity

**Files modified:** `gui-pro/src/index.css`, `gui-pro/src/components/wizard/EndpointStep.tsx`
**Commit:** 99665c4c
**Applied fix:** Added `.wizard-input-sm` CSS class in index.css (inside @layer components, after .wizard-input:focus) with `padding: 0.5rem 1rem` and `font-size: var(--font-size-xs)`. Replaced all 7 occurrences of `wizard-input !py-2 !text-xs` in EndpointStep.tsx with `wizard-input wizard-input-sm`, eliminating all Tailwind !important usage in this component.

## Skipped Issues

None -- all findings were fixed.

---

_Fixed: 2026-04-15T12:30:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
