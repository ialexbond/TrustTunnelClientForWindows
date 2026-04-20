---
phase: 2
slug: ssh-port-change-core-engine
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-14
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Storybook 8.6 (visual) + Vitest (unit tests) |
| **Config file** | `gui-pro/.storybook/main.ts` |
| **Quick run command** | `cd gui-pro && npx vitest run --reporter=verbose 2>&1 \| tail -30` |
| **Full suite command** | `cd gui-pro && npm test && npx storybook build` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd gui-pro && npx vitest run --reporter=verbose 2>&1 | tail -30`
- **After every plan wave:** Run `cd gui-pro && npm test && npx storybook build`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-T1 | 01 | 1 | COMP-13 | — | — | deps+file | `cd gui-pro && grep -q "class-variance-authority" package.json && test -f src/shared/lib/cn.ts && echo OK` | cn.ts | pending |
| 01-T2 | 01 | 1 | COMP-01, COMP-14 | — | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/Button.test.tsx --reporter=verbose` | Button.test.tsx | pending |
| 01-T3 | 01 | 1 | COMP-02, COMP-03 | — | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/Badge.test.tsx src/shared/ui/ErrorBanner.test.tsx --reporter=verbose` | Badge.test.tsx, ErrorBanner.test.tsx | pending |
| 02-T1 | 02 | 2 | COMP-04, COMP-14 | — | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/Input.test.tsx --reporter=verbose` | Input.test.tsx | pending |
| 02-T2 | 02 | 2 | COMP-04, COMP-14 | — | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/NumberInput.test.tsx src/shared/ui/PasswordInput.test.tsx --reporter=verbose` | NumberInput.test.tsx, PasswordInput.test.tsx | pending |
| 03-T1 | 03 | 2 | COMP-06, COMP-14 | — | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/Modal.test.tsx src/shared/ui/ConfirmDialog.test.tsx --reporter=verbose` | Modal.test.tsx, ConfirmDialog.test.tsx | pending |
| 03-T2 | 03 | 2 | COMP-06, COMP-14 | — | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/Toggle.test.tsx src/shared/ui/Card.test.tsx src/shared/ui/Tooltip.test.tsx --reporter=verbose` | Toggle.test.tsx, Card.test.tsx, Tooltip.test.tsx | pending |
| 04-T1 | 04 | 2 | COMP-05, COMP-14 | — | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/Select.test.tsx --reporter=verbose` | Select.test.tsx | pending |
| 04-T2 | 04 | 2 | COMP-01, COMP-14 | — | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/SnackBar.test.tsx src/shared/ui/DropOverlay.test.tsx --reporter=verbose` | SnackBar.test.tsx, DropOverlay.test.tsx | pending |
| 05-T1 | 05 | 3 | COMP-07, COMP-08 | T-02-05-02 | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/Section.test.tsx src/shared/ui/FormField.test.tsx --reporter=verbose` | Section.test.tsx, FormField.test.tsx | pending |
| 05-T2 | 05 | 3 | COMP-09, COMP-10 | T-02-05-01 | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/StatusBadge.test.tsx src/shared/ui/EmptyState.test.tsx --reporter=verbose` | StatusBadge.test.tsx, EmptyState.test.tsx | pending |
| 06-T1 | 06 | 3 | COMP-11, COMP-14 | T-02-06-02 | — | vitest | `cd gui-pro && npx vitest run src/shared/ui/Separator.test.tsx --reporter=verbose` | Separator.test.tsx | pending |
| 06-T2 | 06 | 3 | COMP-12, COMP-14 | T-02-06-01 | clamp 0-100 | vitest | `cd gui-pro && npx vitest run src/shared/ui/ProgressBar.test.tsx --reporter=verbose` | ProgressBar.test.tsx | pending |
| 07-T1 | 07 | 4 | DOC-02 | T-02-07-01 | — | tsc+test | `cd gui-pro && npx tsc --noEmit && npm test` | index.ts, components.md | pending |
| 07-T2 | 07 | 4 | — | — | — | visual | Visual inspection in Storybook by user | *.stories.tsx | pending |
| 07-T3 | 07 | 4 | D-19 | — | — | audit | `cd gui-pro && grep -rn "#[0-9a-fA-F]\{3,6\}" src/shared/ui/*.tsx \| grep -v "test\.\|stories\.\|colors\.ts" \| wc -l` | — | pending |

*Status: pending -- green -- red -- flaky*

---

## Wave 0 Requirements

- [ ] `npm install class-variance-authority tailwind-merge clsx` — CVA dependencies
- [ ] `gui-pro/src/shared/lib/cn.ts` — className merge utility
- [ ] Storybook stories infrastructure verified

*Existing Storybook infrastructure covers visual verification.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Theme toggle visual check | SB-04 | Visual comparison requires human eye | Toggle theme in Storybook, verify all components switch correctly |
| Hover/focus/active states | COMP-14 | Interactive states need manual trigger | Hover, tab, click each component in Storybook |

---

## Nyquist Continuity Check

Every wave must have automated vitest verification. No more than 2 consecutive tasks without automated test runs.

| Wave | Tasks | Automated Verify | Continuity |
|------|-------|------------------|------------|
| 1 | 01-T1, 01-T2, 01-T3 | T2: vitest Button, T3: vitest Badge+ErrorBanner | OK |
| 2 | 02-T1, 02-T2, 03-T1, 03-T2, 04-T1, 04-T2 | All 6 tasks have vitest | OK |
| 3 | 05-T1, 05-T2, 06-T1, 06-T2 | All 4 tasks have vitest | OK (fixed) |
| 4 | 07-T1, 07-T2, 07-T3 | T1: tsc+test, T3: grep audit | OK |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending execution
