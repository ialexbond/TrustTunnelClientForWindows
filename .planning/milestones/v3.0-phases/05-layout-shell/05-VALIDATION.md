---
phase: 05
slug: layout-shell
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-15
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest + jsdom (frontend); cargo test (Rust) |
| **Config file** | `gui-pro/vite.config.ts` (test: { globals: true, environment: "jsdom" }) |
| **Quick run command** | `cd gui-pro && npx vitest run src/components/layout/` |
| **Full suite command** | `cd gui-pro && npx vitest run && cd src-tauri && cargo test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd gui-pro && npx vitest run src/components/layout/ && npx tsc --noEmit`
- **After every plan wave:** Run `cd gui-pro && npx vitest run && cd src-tauri && cargo test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | SCR-10 | — | N/A | unit | `npx vitest run src/components/layout/TabNavigation` | ✅ (expand) | ⬜ pending |
| 05-01-02 | 01 | 1 | SCR-10 | — | N/A | unit | `npx vitest run src/components/ServerSidebar` | ❌ W0 | ⬜ pending |
| 05-01-03 | 01 | 1 | SCR-10 | — | N/A | unit | `npx vitest run src/components/ServerTabs` | ❌ W0 | ⬜ pending |
| 05-02-01 | 02 | 1 | SCR-10 | — | N/A | type-check | `npx tsc --noEmit` | ✅ | ⬜ pending |
| 05-02-02 | 02 | 1 | SCR-10 | — | N/A | visual | grep for color tokens | ✅ | ⬜ pending |
| 05-03-01 | 03 | 2 | SCR-10 | — | N/A | unit | `npx vitest run src/shared/ui/StatusBadge` | ✅ | ⬜ pending |
| 05-03-02 | 03 | 2 | SCR-10 | T-05-01 | sanitize() masks all sensitive key occurrences in logs | unit (Rust) | `cargo test -- sanitize_replaces_all_occurrences` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `gui-pro/src/components/ServerSidebar.test.tsx` — test `servers.length < 2 → sidebar hidden`
- [ ] `gui-pro/src/components/ServerTabs.test.tsx` — test state preservation on tab switch

*Existing infrastructure covers remaining phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Border removal visually correct | SCR-10 / D-01 | Visual — no borders between TitleBar/content/TabBar | Open app, inspect all shell boundaries in light+dark theme |
| Sidebar animation smooth | D-11 | Animation timing subjective | Toggle server count, verify sidebar slides in/out smoothly |
| Auth button contrast | D-15 | Color perception | Check auth toggle buttons on light theme — should not appear washed out |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
