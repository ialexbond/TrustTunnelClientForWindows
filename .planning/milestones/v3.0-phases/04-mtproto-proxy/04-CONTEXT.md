# Phase 4: Application Shell - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

> **IMPORTANT: Scope change.** Phase 4 was originally "Remaining Panels" (7 screens).
> User restructured it to "Application Shell" (WindowControls + Navigation + ServerSidebar).
> Individual screen migrations will be split into separate phases.
> **ROADMAP.md needs updating before planning.**

<domain>
## Phase Boundary

Phase 4 delivers the **application shell** — the frame that wraps all content. This includes:

- **WindowControls** (custom title bar) — minimize, maximize, close + app name
- **Navigation** — top tabs replacing the current sidebar (complete rearchitecture)
- **ServerSidebar** — redesigned to fit the new layout
- **Visual seamlessness** — unified background, minimal borders, bespoke separation

This is the "general to specific" approach: shell first, then individual screens.

NOT in scope:
- Individual screen redesigns (ServerPanel, RoutingPanel, etc.) — separate future phases
- Setup Wizard redesign — separate future phase
- Multi-server functionality — future milestone

</domain>

<decisions>
## Implementation Decisions

### Navigation Architecture
- **D-01:** Navigation model: **horizontal tabs at the top**, full width of the window. Sidebar is removed.
- **D-02:** Tab placement relative to WindowControls: **Claude's discretion** (best practices, stylish)
- **D-03:** Tab count reduced from 8 to **5 tabs**:
  1. **Панель управления** — entry point: SSH connect, VPN status, install protocol, import/export config
  2. **Подключение** — VPN connection configuration + logs (LogPanel folded in)
  3. **Маршрутизация** — GeoIP/GeoSite traffic rules
  4. **Настройки** — App settings (language, theme, autostart)
  5. **О программе** — Version, changelog, updates
- **D-04:** Dashboard (SCR-07) is **disbanded** — server info moves to Панель управления, client/VPN info moves to Подключение
- **D-05:** LogPanel is **folded into Подключение** — not a separate tab
- **D-06:** Tab names must be **simple and intuitive**. Balance between professionalism and accessibility for non-IT users. Not dumbed down, but clear.

### WindowControls
- **D-07:** Title bar contains: **app name (TrustTunnel Pro / Lite)** + minimize/maximize/close buttons
- **D-08:** All icons and hover effects styled per design system (tokens, consistent hover)
- **D-09:** Title bar is **seamless** — same background as content, no border-bottom. Like Spotify, Linear

### Visual Seamlessness
- **D-10:** Unified background across the entire app (warm cream for light, dark for dark theme)
- **D-11:** Blocks differentiated by **subtle background shade variations**, not hard borders
- **D-12:** Visual separation approach: **Claude's discretion** — balance spacing, shade differences, and minimal borders to eliminate "squareness"
- **D-13:** Both themes must feel like one cohesive seamless system

### ServerSidebar
- **D-14:** ServerSidebar stays and gets **full redesign** per design system
- **D-15:** Placement in the new top-tabs layout: **Claude's discretion**
- **D-16:** Current hardcoded Tailwind colors must be replaced with design tokens

### Scope Restructuring
- **D-17:** Phase 4 scope changed from "Remaining Panels" (7 screens) to "Application Shell" (window + navigation + ServerSidebar)
- **D-18:** Individual screen migrations will become separate phases after Phase 4
- **D-19:** ROADMAP.md must be updated to reflect new phase structure before planning begins

### Claude's Discretion
- Tab placement relative to WindowControls (best practices)
- Visual separation strategy (spacing vs shades vs minimal borders)
- ServerSidebar placement in the new layout
- Tab naming in English for i18n keys (Russian names locked above)
- Logo placement (currently in sidebar, needs new home)
- Exact component naming and directory structure for new layout components

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 1-3 Design Decisions (locked)
- `.planning/phases/01-infrastructure-release-setup/01-CONTEXT.md` — D-01 to D-13: visual direction, restrained elegance, near-monochrome, Linear/Raycast reference, no glow, warm cream light, deep dark
- `.planning/phases/02-ssh-port-change-core-engine/02-CONTEXT.md` — D-01 to D-19: CVA + Tailwind, full redesign approach, shadcn/ui reference
- `.planning/phases/03-ssh-port-change-integration/03-CONTEXT.md` — D-01 to D-12: SnackBar + ErrorBanner pattern, full visual redesign not token swap

### Design System Foundation
- `gui-pro/src/shared/styles/tokens.css` — Two-tier token system (primitives + semantics), slate-teal accent
- `gui-pro/src/shared/styles/fonts/` — Geist Sans + Geist Mono

### Source Code (current state to transform)
- `gui-pro/src/components/layout/WindowControls.tsx` — Current: 3 buttons, hardcoded RGBA, no tokens
- `gui-pro/src/components/layout/Sidebar.tsx` — Current: hover-expand sidebar with 8 nav items, imports colors.ts
- `gui-pro/src/components/ServerSidebar.tsx` — Current: 200px left panel, server list, hardcoded Tailwind colors
- `gui-pro/src/App.tsx` — Contains Sidebar integration, page routing, SidebarPage type

### Design Philosophy
- `memory/decisions/v3-philosophy.md` — Contract-first development process
- `memory/decisions/v3-design-guidelines.md` — Visual direction, anti-patterns

</canonical_refs>

<code_context>
## Existing Code Insights

### Components to Transform
- `WindowControls` (66 lines) — 3 SVG buttons, useState for hover, hardcoded RGBA. Needs full token migration + title bar content
- `Sidebar` (199 lines) — hover-expand pattern, 8 NavItems, colors.ts import, SidebarPage type. Must be **replaced** with top tabs component
- `ServerSidebar` (108 lines) — server list with status dots, disconnect button. Needs token migration and visual redesign

### Established Patterns
- CVA + Tailwind for all component styling (Phase 2 standard)
- All colors via CSS custom properties from tokens.css
- `cn()` utility for merging Tailwind classes
- `useTranslation()` hook for i18n (ru/en)
- `SidebarPage` type in Sidebar.tsx — must be refactored to reflect new tab structure

### Integration Points
- `App.tsx` imports `Sidebar` and `SidebarPage` type — must update to new tab navigation
- `ControlPanelPage.tsx` — currently conditional on SSH creds, contains ServerPanel
- ServerSidebar embedded in ControlPanelPage — stays but with new visual treatment
- Tab routing in App.tsx needs update for 5-tab structure (was 8 pages)

### Breaking Changes Expected
- `SidebarPage` type deleted/renamed → all consumers update
- Sidebar component removed → replaced with TabNavigation (or similar)
- `activePage` state and `onPageChange` callbacks → adapt to new tab model
- Navigation item IDs: `server` and `dashboard` removed, `logs` folded into `settings`/`control`

</code_context>

<specifics>
## Specific Ideas

- User wants "general to specific" approach: shell first, screens later
- Intuitive navigation for non-IT users, but not dumbed down — professional balance
- App should feel "expensive" (дорогой) — seamless, minimal, high contrast
- Single unified background per theme, blocks differentiated by subtle shade variations
- No glow effects (Phase 1 decision), shadows only
- User specifically mentioned: "бесшовность и минимализм" as core design values for the shell
- Dashboard data redistributed: server info → Панель управления, client/VPN info → Подключение

</specifics>

<deferred>
## Deferred Ideas

- **Multi-server functionality** — storing multiple servers, switching without re-entering credentials. New capability → separate milestone
- **Individual screen redesigns** — ServerPanel, RoutingPanel, SettingsPanel, etc. → separate phases after shell is done
- **Setup Wizard redesign** — separate phase
- **Component naming audit** — user mentioned wanting to audit component names and responsibilities. Can be done during or after shell redesign

### Reviewed Todos (not folded)
- "Кнопки серверных секций — несуществующие варианты Button" — belongs to ServerPanel redesign phase
- "ServerTabs — сохранять состояние табов" — ServerPanel navigation, not app shell
- "Кнопки auth — слишком белые на светлой теме" — ControlPanel Phase 3 issue
- "Кнопки серверных секций отображаются некорректно" — ServerPanel redesign phase
- "Табы — заменить индикатор на современный стиль" — ServerTabs inside ServerPanel
- "Смягчить угловатость UI" — partially addressed by D-10/D-11/D-12 (seamlessness decisions)
- "i18n — зашитые русские строки" — design-system level fix, not app shell specific
- "Sidebar hardcoded colors" — addressed directly by this phase (Sidebar replacement)
- Other lower-relevance todos: server button bugs, credentials persist, IP dedup, status re-render — belong to screen-specific phases

</deferred>

---

*Phase: 04-application-shell*
*Context gathered: 2026-04-14*
