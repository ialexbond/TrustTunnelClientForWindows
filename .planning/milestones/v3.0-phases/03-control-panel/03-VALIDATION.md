---
phase: 3
slug: control-panel
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-14
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3.1 |
| **Config file** | gui-pro/vitest.config.ts |
| **Quick run command** | `cd gui-pro && npx vitest run --reporter=verbose` |
| **Full suite command** | `cd gui-pro && npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd gui-pro && npx vitest run --reporter=verbose`
- **After every plan wave:** Run `cd gui-pro && npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | Status |
|---------|------|------|-------------|-----------|-------------------|--------|
| 03-xx-01 | TBD | TBD | SCR-01 | unit | `npx vitest run ControlPanelPage` | ⬜ pending |
| 03-xx-02 | TBD | TBD | SCR-02 | unit | `npx vitest run StatusPanel` | ⬜ pending |
| 03-xx-03 | TBD | TBD | DOC-03 | manual | file existence check | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Add `vpnErrors.*` i18n keys to `ru.json` and `en.json` (ErrorBanner copy)
- [ ] Update StatusPanel test assertions: Badge text → StatusBadge uppercase text

*Existing vitest infrastructure covers all phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Storybook stories render all VPN states | SCR-01, SCR-02 | Visual verification | Open Storybook, check StatusPanel/ControlPanelPage stories in dark/light |
| memory/v3/screens/ spec exists | DOC-03 | File content review | Check memory/v3/screens/control-panel.md completeness |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
