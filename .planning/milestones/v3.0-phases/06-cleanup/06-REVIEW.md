---
phase: 06-cleanup
reviewed: 2026-04-15T12:00:00Z
depth: standard
files_reviewed: 23
files_reviewed_list:
  - gui-pro/src/shared/styles/tokens.css
  - gui-pro/tailwind.config.js
  - gui-pro/src/index.css
  - gui-pro/src/components/AboutPanel.tsx
  - gui-pro/src/components/ChangelogModal.tsx
  - gui-pro/src/components/ConfigPanel.tsx
  - gui-pro/src/components/routing/ProcessPickerModal.tsx
  - gui-pro/src/components/routing/RuleEntryRow.tsx
  - gui-pro/src/components/server/DangerZoneSection.tsx
  - gui-pro/src/components/server/ExportSection.tsx
  - gui-pro/src/components/server/FirewallSection.tsx
  - gui-pro/src/components/server/UsersSection.tsx
  - gui-pro/src/components/server/UsersSection.test.tsx
  - gui-pro/src/components/server/VersionSection.tsx
  - gui-pro/src/components/server/_securityHelpers.tsx
  - gui-pro/src/components/settings/ConnectionSection.tsx
  - gui-pro/src/components/wizard/DoneStep.tsx
  - gui-pro/src/components/wizard/EndpointStep.tsx
  - gui-pro/src/components/wizard/ErrorStep.tsx
  - gui-pro/src/components/wizard/FoundStep.tsx
  - gui-pro/src/components/wizard/ImportConfigModal.tsx
  - gui-pro/src/components/wizard/StepBar.tsx
  - gui-pro/src/components/wizard/WelcomeStep.tsx
findings:
  critical: 0
  warning: 3
  info: 3
  total: 6
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-04-15T12:00:00Z
**Depth:** standard
**Files Reviewed:** 23
**Status:** issues_found

## Summary

Phase 6 cleanup is largely successful. The token migration from inline `rgba()` to CSS custom property tint tokens is complete across the reviewed components. The tint token definitions in `tokens.css` are well-structured: dark theme tints use the `-500` palette bases and light theme tints use the `-600` palette bases, both consistent with the accent-interactive semantic alias for each theme. The surface palette was removed from `tailwind.config.js`, and `!important` overrides were removed from `index.css`. The `.wizard-input:focus` box-shadow now correctly references `--color-accent-tint-15`.

However, three issues remain from the cleanup scope and three minor quality items were found in the reviewed files.

## Warnings

### WR-01: ConfigPanel still uses hardcoded Tailwind color classes (not tokenized)

**File:** `gui-pro/src/components/ConfigPanel.tsx:16-81`
**Issue:** ConfigPanel is entirely un-tokenized. It uses `text-indigo-400`, `text-gray-400`, `text-gray-500`, `text-gray-200`, `text-gray-600`, `placeholder-gray-600`, `bg-white/5`, `border-white/10`, `hover:bg-white/10`, `focus:border-indigo-500/50`, `focus:ring-indigo-500/25`, and `border-white/5`. These are hardcoded Tailwind color utilities that bypass the design system tokens entirely. This panel will render incorrectly in light theme and is inconsistent with every other reviewed component.
**Fix:** Replace all Tailwind color classes with token references, following the same pattern as other components. For example:
```tsx
// Before:
<Settings className="w-3.5 h-3.5 text-indigo-400" />
<h2 className="... text-gray-400">

// After:
<Settings className="w-3.5 h-3.5" style={{ color: "var(--color-accent-400)" }} />
<h2 className="..." style={{ color: "var(--color-text-secondary)" }}>
```
Replace `bg-white/5` with `style={{ backgroundColor: "var(--color-input-bg)" }}`, `border-white/10` with `style={{ borderColor: "var(--color-input-border)" }}`, etc.

### WR-02: `backgroundColor: "none"` is invalid CSS in StepBar and RuleEntryRow

**File:** `gui-pro/src/components/wizard/StepBar.tsx:57`
**Issue:** `backgroundColor: "none"` is not a valid CSS value. The `background-color` property does not accept `none` -- only `transparent`, `inherit`, specific color values, etc. In practice, browsers treat the invalid value as if it were not set, falling back to the inherited/initial value. The intended effect is likely `"transparent"`.
**File:** `gui-pro/src/components/routing/RuleEntryRow.tsx:23-24`
**Issue:** Same issue in `typeBadgeBg` map for `ip` and `cidr` entries: `"none"` should be `"transparent"`.
**Fix:**
```tsx
// StepBar.tsx line 57:
{ backgroundColor: "transparent", color: "var(--color-accent-500)", boxShadow: "0 0 0 2px var(--color-accent-tint-50)" }

// RuleEntryRow.tsx lines 23-24:
ip: "transparent",
cidr: "transparent",
```

### WR-03: Wizard EndpointStep uses Tailwind !important overrides to fight .wizard-input specificity

**File:** `gui-pro/src/components/wizard/EndpointStep.tsx:41,53,145,163,185,201,268`
**Issue:** Seven inputs use `className="wizard-input !py-2 !text-xs"` where the `!` prefix forces Tailwind `!important`. This pattern exists because `.wizard-input` in `index.css` sets `padding: 0.75rem 1rem` and `font-size: 0.875rem`, and the component needs smaller values. While this works, it is a code smell: `!important` overrides make the specificity chain fragile and harder to maintain. The cleanup phase removed `!important` from `index.css` but did not address this source of `!important` in components.
**Fix:** Consider adding a `.wizard-input-sm` variant in `index.css` with the smaller padding/font-size, or use inline styles for the overrides instead of `!important`:
```css
/* In index.css */
.wizard-input-sm {
  padding: 0.5rem 1rem;
  font-size: var(--font-size-xs);
}
```
Then use `className="wizard-input wizard-input-sm"` without `!important`.

## Info

### IN-01: ConfigPanel uses hardcoded Russian strings instead of i18n

**File:** `gui-pro/src/components/ConfigPanel.tsx:18,25,51,82`
**Issue:** Four user-facing strings are hardcoded in Russian: "Nastroiki" (line 18), "Fail konfiguracii" (line 25), "Vybrat' fail" (line 51), "Uroven' logirovaniya" (line 59). All other reviewed components use `useTranslation()`. This component does not import or call `useTranslation`.
**Fix:** Import `useTranslation` and replace hardcoded strings with translation keys, following the existing `ru.json`/`en.json` pattern.

### IN-02: ConfigPanel hardcodes un-translated label text for sidecar info

**File:** `gui-pro/src/components/ConfigPanel.tsx:82`
**Issue:** `<p>Sidecar: trusttunnel_client - TOML</p>` is hardcoded text in the footer. While this is developer-facing info, it is inconsistent with the i18n approach used everywhere else.
**Fix:** Either wrap in a translation key or leave as-is if this panel is only used in a developer/debug context. Low priority.

### IN-03: Unused import `_onClearConfig` in DangerZoneSection

**File:** `gui-pro/src/components/server/DangerZoneSection.tsx:27`
**Issue:** `onClearConfig` is destructured from `state` and immediately aliased to `_onClearConfig` with an underscore prefix, indicating it is intentionally unused. While the underscore convention suppresses linter warnings, the import itself is dead code.
**Fix:** Remove the destructuring if `onClearConfig` is not needed in this component:
```tsx
// Remove this line:
onClearConfig: _onClearConfig,
```

---

_Reviewed: 2026-04-15T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
