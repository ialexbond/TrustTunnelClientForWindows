# Phase 5: Shell Polish + TODO Closure - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-15
**Phase:** 05-layout-shell
**Areas discussed:** Visual Softness, Tab Navigation + TitleBar, ServerSidebar UX, Bug Fixes + Design-System Cleanup

---

## Phase Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Layout Shell (original) | Sidebar + WindowControls redesign per ROADMAP | |
| Полировка + TODO | Visual softness, bug fixes, design-system cleanup | ✓ |
| Skip phase | Phase 4 already delivered shell, skip to Phase 6 | |

**User's choice:** Полировка + TODO
**Notes:** Phase 4 already delivered the Layout Shell work (Application Shell). Phase 5 redefined as visual polish and backlog closure for the shell built in Phase 4.

---

## TODO Scope

19 unique todos identified (deduplicated from 24 files across memory/ and .planning/todos/pending/).

**User's choice:** Include all todos. "Надо включить все, что есть во всех Туду, которые там записаны..."
**Notes:** 2 items deferred: shell-disabled-onboarding (obsolete — hasConfig removed in Phase 4), credentials-persist (multi-server concern, not relevant with 1 server + hidden sidebar).

---

## Visual Softness

| Option | Description | Selected |
|--------|-------------|----------|
| Remove all borders | Separation only via spacing + background shade | ✓ |
| Soften borders | Replace hard borders with subtle dividers | |
| Mixed approach | Borders in some areas, spacing in others | |

**User's choice:** "Убрать все бордеры" — remove ALL borders between shell components
**Notes:** User explicitly said to remove all borders. Separation achieved through spacing and subtle background shade differences only. Like Linear, Notion approach. ServerSidebar separation strategy left to Claude's discretion.

---

## Tab Navigation + TitleBar

### Active Tab Style

| Option | Description | Selected |
|--------|-------------|----------|
| Elevated pill (current) | bg-elevated, 120x44px background pill | ✓ |
| Accent underline | 3px accent bar at bottom, 60% width | |
| Combined | Subtle bg + underline | |

**User's choice:** "Elevated pill (текущий)" — keep current elevated pill style
**Notes:** User chose to keep the existing style. No change to active tab indicator.

### TitleBar

| Option | Description | Selected |
|--------|-------------|----------|
| Keep as-is | No changes to font, size, logo | ✓ |
| Enhance | Increase font size, add logo container | |

**User's choice:** Keep as-is. "Не сильно приметное, достаточно читаемое, не выбивающееся"
**Notes:** User confirmed TitleBar is good as-is — compact, readable, doesn't stand out. No font/size/logo changes needed.

---

## ServerSidebar UX

### Sidebar Visibility

| Option | Description | Selected |
|--------|-------------|----------|
| Hide completely | Hide sidebar when 1 server exists | ✓ |
| Collapse to icons | Narrow icon strip when 1 server | |
| Always show | Keep sidebar visible regardless | |

**User's choice:** "Скрыть полностью" — hide ServerSidebar completely when only 1 server exists
**Notes:** Show only at 2+ servers. Add smooth transition animation for show/hide.

### Status Dots

| Option | Description | Selected |
|--------|-------------|----------|
| Remove entirely | No status indicators until multi-server | ✓ |
| Redesign | New status indicator approach | |
| Keep current | Dots with current behavior | |

**User's choice:** Remove status dots entirely
**Notes:** User initially couldn't remember proposal details but confirmed "not server status, that's meaningless." Decision: remove entirely, bring back with real status in multi-server milestone.

---

## Bug Fixes + Design-System Cleanup

| Option | Description | Selected |
|--------|-------------|----------|
| All 8 items | All bug fixes + all design-system cleanup | ✓ |
| Bugs only | Only the 4 bug fix items | |
| Critical only | Only blocking issues | |

**User's choice:** "Все 8 пунктов" — include all bug fixes and design-system cleanup items
**Notes:** Includes: invalid Button variants (D-12), tab rerender (D-13), tabs preserve state (D-14), auth buttons color (D-15), sidebar hardcoded colors (D-16), i18n hardcoded strings (D-17), sanitize fix (D-18), disconnect a11y (D-19).

---

## Claude's Discretion

- ServerSidebar to content separation strategy (D-03) — best approach without borders
- Tab max-width approach on wide windows (D-05) — CSS max-width, centering, or container constraint
- Sidebar show/hide animation easing and duration (D-11)
- Component state caching approach for tab rerender fix (D-13, D-14)

## Deferred Ideas

- **ip-dedup-rename** — Server IP shown 3x. Deferred: sidebar hidden with 1 server reduces duplication. Full fix in multi-server milestone.
- **credentials-persist** — Credentials lost on server switch. Deferred: single-server scenario, sidebar hidden.
- **shell-disabled-onboarding** — OBSOLETE: hasConfig removed in Phase 4, all tabs always accessible.
