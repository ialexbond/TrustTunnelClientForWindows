---
phase: 1
slug: infrastructure-release-setup
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-13
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Storybook test-runner + vitest (gui-pro already has vitest) |
| **Config file** | gui-pro/.storybook/main.ts (Phase 1 creates), gui-pro/vite.config.ts (existing) |
| **Quick run command** | `cd gui-pro && npx storybook dev --ci --smoke-test` |
| **Full suite command** | `cd gui-pro && npx storybook build --test 2>&1 | head -50` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd gui-pro && npx storybook dev --ci --smoke-test`
- **After every plan wave:** Run `cd gui-pro && npx storybook build --test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | DS-01 | — | N/A | file-check | `grep -- '--color-accent-400' gui-pro/src/shared/styles/tokens.css` | TBD | ⬜ pending |
| TBD | TBD | TBD | DS-02 | — | N/A | file-check | `grep -- '--color-bg-primary' gui-pro/src/shared/styles/tokens.css` | TBD | ⬜ pending |
| TBD | TBD | TBD | SB-01 | — | N/A | smoke | `cd gui-pro && npx storybook dev --ci --smoke-test` | TBD | ⬜ pending |
| TBD | TBD | TBD | QA-01 | — | N/A | file-check | `grep 'data-theme' gui-pro/index.html` | TBD | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `gui-pro/.storybook/main.ts` — Storybook config with viteFinal Tauri mocks
- [ ] `gui-pro/.storybook/preview.ts` — imports tokens.css, registers theme decorator
- [ ] `@storybook/react-vite`, `@storybook/addon-themes` — npm install

*Storybook does not exist yet — Wave 0 must install and configure from scratch.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Theme toggle in Storybook toolbar | SB-06 | Requires browser interaction | Open Storybook, click theme toggle, verify dark/light switch |
| No theme flash on app load | QA-01 | Requires visual observation | Load app fresh, verify no white flash before dark theme |
| MDX Foundations pages render | SB-07, DOC-01 | Visual content check | Navigate to Colors/Typography/Spacing/Shadows pages |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
