---
phase: 4
slug: application-shell
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-14
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest + @testing-library/react |
| **Config file** | `gui-app/vitest.config.ts` |
| **Quick run command** | `cd gui-app && npx vitest run --reporter=verbose` |
| **Full suite command** | `cd gui-app && npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd gui-app && npx vitest run --reporter=verbose`
- **After every plan wave:** Run `cd gui-app && npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-03-01 | 03 | 1 | SCR-07 | — | N/A | typecheck | `npx tsc --noEmit` | N/A | ⬜ pending |
| 04-03-02 | 03 | 1 | DOC-04 | — | N/A | script | `node -e "..."` (i18n verify) | N/A | ⬜ pending |
| 04-03-03 | 03 | 1 | DOC-04 | — | N/A | script | `node -e "..."` (ROADMAP verify) | N/A | ⬜ pending |
| 04-04-01 | 04 | 2 | SCR-03, SCR-04, SCR-05, SCR-06 | T-04-03 | disabled tabs guarded | unit | `npx vitest run TabNavigation TitleBar` | ❌ W0 | ⬜ pending |
| 04-04-02 | 04 | 2 | SCR-03 | T-04-04, T-04-05 | platform close button | typecheck | `npx tsc --noEmit` | N/A | ⬜ pending |
| 04-05-01 | 05 | 3 | SCR-08, SCR-09 | T-04-06, T-04-07 | tabMap strict mapping | typecheck | `npx tsc --noEmit` | N/A | ⬜ pending |
| 04-05-02 | 05 | 3 | SCR-08 | T-04-08 | token migration | typecheck+test | `npx tsc --noEmit && npx vitest run` | N/A | ⬜ pending |
| 04-06-01 | 06 | 4 | DOC-04 | — | N/A | typecheck | `npx tsc --noEmit` | N/A | ⬜ pending |
| 04-06-02 | 06 | 4 | DOC-05 | — | N/A | script | `node -e "..."` (doc verify) | N/A | ⬜ pending |
| 04-06-03 | 06 | 4 | — | — | N/A | manual | Human visual checkpoint | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `gui-app/src/components/layout/TabNavigation.test.tsx` — stubs for TabNavigation
- [ ] `gui-app/src/components/layout/TitleBar.test.tsx` — stubs for TitleBar (renders Shield icon, TrustTunnel text, PRO badge, no border-bottom, imports WindowControls)
- [ ] Replace `gui-app/src/components/layout/Sidebar.test.tsx` with TabNavigation tests

*Existing vitest infrastructure covers the test framework — no new install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Title bar drag region | SCR-11 | Requires Tauri window + mouse interaction | Build app, verify title bar is draggable |
| Tab keyboard navigation | SCR-10 | Requires focus management testing | Tab through tabs with keyboard, verify arrow keys work |
| Seamless visual appearance | Design contract | Visual judgment | Screenshot comparison in Storybook dark + light |
| WindowControls close button red hover | SCR-11 | Platform-specific visual | Hover over close button, verify #e81123 background |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
