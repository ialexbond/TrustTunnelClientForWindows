# Phase 5: Shell Polish + TODO Closure - Context

**Gathered:** 2026-04-15
**Status:** Ready for planning

> **Scope change.** Phase 5 was originally "Layout Shell" (Sidebar + WindowControls redesign).
> Phase 4 already delivered this work as "Application Shell".
> Phase 5 is now **Shell Polish + TODO Closure** — visual softness, bug fixes, design-system cleanup.

<domain>
## Phase Boundary

Phase 5 delivers **visual polish and backlog closure** for the application shell built in Phase 4. This includes:

- **Visual softness** — remove all hard borders, soften separation between blocks
- **Tab + TitleBar refinements** — keep elevated pill, fix max-width on wide windows
- **ServerSidebar UX** — hide when 1 server, remove status dots until multi-server
- **Bug fixes** — invalid button variants, tab rerender, add-server button, tabs preserve state
- **Design-system cleanup** — sidebar tokens, i18n hardcoded strings, sanitize fix, disconnect a11y

NOT in scope:
- Individual screen redesigns (Settings, Routing, etc.) — Phase 6 or separate phases
- Multi-server functionality — future milestone
- TitleBar visual changes — user confirmed current style is good

</domain>

<decisions>
## Implementation Decisions

### Visual Softness
- **D-01:** Remove ALL borders (`1px solid var(--color-border)`) between shell components (TitleBar ↔ content ↔ TabBar)
- **D-02:** Separation achieved through spacing + subtle background shade differences only. Like Linear, Notion.
- **D-03:** ServerSidebar separation from content: **Claude's discretion** — best approach without borders (subtle bg shift, shadow, spacing, or fully seamless)

### Tab Navigation
- **D-04:** Active tab indicator: **keep elevated pill** (bg-elevated, 120x44px). No change to underline.
- **D-05:** Fix tab max-width on wide windows (1200px+) — constrain or center tab group
- **D-06:** Add arrow-key roving focus between tabs (WAI-ARIA tablist pattern)

### TitleBar
- **D-07:** TitleBar stays as-is — user likes compact, unobtrusive style. No font/size/logo changes.

### ServerSidebar
- **D-08:** Hide ServerSidebar completely when only 1 server exists. Show only at 2+ servers.
- **D-09:** Remove status dots entirely — bring back with real status in multi-server milestone.
- **D-10:** Fix "Add Server" button — must not disconnect active VPN connection.
- **D-11:** Layout shift when sidebar appears/disappears — add smooth transition animation.

### Bug Fixes (all included)
- **D-12:** Fix invalid Button variants in ServerPanel sections (secondary→ghost, success→primary, etc.)
- **D-13:** Fix tab rerender — cache component state instead of unmounting on tab switch
- **D-14:** Fix tabs-preserve-state — ServerTabs should not remount on switch
- **D-15:** Fix auth buttons color — too white on light theme

### Design-System Cleanup (all included)
- **D-16:** Replace hardcoded Tailwind colors in sidebar with design tokens
- **D-17:** Replace hardcoded Russian strings with i18n keys in Select, StatusBadge, EmptyState
- **D-18:** Fix sanitize() to mask all occurrences of sensitive keys (security fix)
- **D-19:** Disconnect button a11y — visible for keyboard-only users (group-focus-within)

### Obsolete TODOs (from Phase 4 changes)
- **shell-disabled-onboarding.md** — OBSOLETE: hasConfig was removed in Phase 4, all tabs always accessible
- **credentials-persist.md** — DEFERRED: multi-server concern, not relevant with 1 server + hidden sidebar

### Claude's Discretion
- ServerSidebar ↔ content separation strategy (D-03)
- Tab max-width approach: max-width CSS, centering, or container constraint (D-05)
- Sidebar show/hide animation easing and duration (D-11)
- Component state caching approach: CSS display:none vs conditional rendering vs React.memo (D-13, D-14)

### Folded Todos
All 16 todos from `.planning/todos/pending/` are folded into this phase:
- layout-shift, tab-maxwidth, visual-softness, tabs-style (UI)
- ip-dedup-rename (deferred per D-08 — sidebar hidden with 1 server)
- server-section-buttons, server-sections-invalid-variants (bug)
- add-server-button, tabs-preserve-state, status-tab-rerender (bug)
- auth-buttons-color, shell-disconnect-keyboard (UI/a11y)
- sidebar-hardcoded-colors, i18n-hardcoded-strings (design-system)
- shell-disabled-onboarding (OBSOLETE), credentials-persist (DEFERRED)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design System
- `gui-pro/src/tokens.css` — All design tokens (primitives + semantics)
- `gui-pro/src/index.css` — Global styles, remaining Tailwind overrides

### Shell Components (Phase 4 outputs)
- `gui-pro/src/components/layout/TitleBar.tsx` — Custom title bar (32px, seamless)
- `gui-pro/src/components/layout/TabNavigation.tsx` — Bottom tabs (5 tabs, 56px, elevated pill)
- `gui-pro/src/components/layout/WindowControls.tsx` — Minimize/maximize/close
- `gui-pro/src/components/ServerSidebar.tsx` — Server list sidebar
- `gui-pro/src/App.tsx` — Tab routing, startup logic

### Bug Fix Targets
- `gui-pro/src/components/server/` — ServerPanel sections with invalid Button variants
- `gui-pro/src/shared/ui/Select.tsx` — Hardcoded Russian strings
- `gui-pro/src/shared/ui/StatusBadge.tsx` — Hardcoded Russian strings
- `gui-pro/src/shared/ui/EmptyState.tsx` — Hardcoded Russian strings

### Todo Files
- `.planning/todos/pending/` — All 16 todo files with detailed descriptions

### Prior Context
- `.planning/phases/04-mtproto-proxy/04-CONTEXT.md` — Phase 4 decisions (seamless design, 5 tabs, etc.)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TabNavigation.tsx` — Already has focus-visible ring, 120x44px button pill, seamless bg
- `tokens.css` — Full semantic token system including `--color-bg-hover`, `--color-bg-elevated`
- `Sonner` — Toast library installed, can be used for transition animations or notifications
- Emil Kowalski skill — Animation philosophy loaded, applies to sidebar transitions

### Established Patterns
- Seamless design: components transparent, body bg-primary propagates
- CSS custom properties for all colors (two-tier: primitives + semantics)
- Tailwind + inline styles hybrid (className for layout, style for token vars)
- i18n via react-i18next: `useTranslation()` hook + `t()` calls

### Integration Points
- `App.tsx` renders ServerSidebar conditionally based on tab + server count
- `ServerSidebar.tsx` currently always visible on control tab
- Tab routing in App.tsx determines which panel renders

</code_context>

<specifics>
## Specific Ideas

- User explicitly said "убрать все бордеры" — no borders at all, separation only through spacing/background
- TitleBar confirmed good as-is — "не сильно приметное, достаточно читаемое, не выбивающееся"
- Active tab pill stays — user chose elevated pill over underline
- Status dots: user couldn't remember exact proposal but confirmed "not server status, that's meaningless" — remove entirely

</specifics>

<deferred>
## Deferred Ideas

- **ip-dedup-rename** — Server IP shown 3x on screen. Deferred: sidebar will be hidden with 1 server, reduces duplication. Full fix in multi-server milestone.
- **credentials-persist** — Credentials lost on server switch. Deferred: single-server scenario, sidebar hidden. Full fix in multi-server milestone.
- **shell-disabled-onboarding** — OBSOLETE: hasConfig removed in Phase 4, all tabs always accessible.

### Reviewed Todos (not folded)
- `shell-disabled-onboarding.md` — Obsolete, hasConfig removed
- `credentials-persist.md` — Deferred to multi-server milestone

</deferred>

---

*Phase: 05-layout-shell*
*Context gathered: 2026-04-15*
