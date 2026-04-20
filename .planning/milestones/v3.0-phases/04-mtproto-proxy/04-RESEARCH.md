# Phase 4: Application Shell - Research

**Researched:** 2026-04-14
**Domain:** React layout architecture, Tauri window controls, tab navigation, design token migration
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Navigation model: horizontal tabs at the top, full width of the window. Sidebar removed.
- **D-02:** Tab placement relative to WindowControls: Claude's discretion (see below — resolved in UI-SPEC as two separate rows)
- **D-03:** 5 tabs: Панель управления / Подключение / Маршрутизация / Настройки / О программе
- **D-04:** Dashboard disbanded — server info moves to Панель управления, client/VPN info to Подключение
- **D-05:** LogPanel folded into Подключение — not a separate tab
- **D-06:** Tab names simple and intuitive, balance professionalism and accessibility
- **D-07:** Title bar: app name (TrustTunnel Pro / Lite) + minimize/maximize/close
- **D-08:** All icons and hover effects styled per design system (tokens, consistent hover)
- **D-09:** Title bar seamless — same background as content, no border-bottom (like Spotify, Linear)
- **D-10:** Unified background across entire app (warm cream light / dark dark)
- **D-11:** Blocks differentiated by subtle background shade variations, not hard borders
- **D-12:** Visual separation approach: Claude's discretion — balance spacing, shade differences, minimal borders
- **D-13:** Both themes must feel cohesive, seamless
- **D-14:** ServerSidebar stays, gets full redesign per design system
- **D-15:** ServerSidebar placement: Claude's discretion (resolved in UI-SPEC as left column, control tab only)
- **D-16:** Current hardcoded Tailwind colors in ServerSidebar replaced with design tokens
- **D-17:** Phase scope changed from "Remaining Panels" to "Application Shell"
- **D-18:** Individual screen migrations will become separate phases after Phase 4
- **D-19:** ROADMAP.md must be updated before planning begins

### Claude's Discretion

- Tab placement relative to WindowControls (UI-SPEC resolved: separate rows — title bar 32px above, tab bar 40px below)
- Visual separation strategy (UI-SPEC resolved: no borders between title/tab/content; ServerSidebar uses 1px --color-border right edge)
- ServerSidebar placement (UI-SPEC resolved: left column inside content area, control tab only)
- Tab naming in English for i18n keys (UI-SPEC resolved: see Tab Definitions table)
- Logo placement (UI-SPEC resolved: moves to title bar left — Shield icon + "TrustTunnel" + "PRO" badge)
- Exact component naming and directory structure (UI-SPEC resolved: TitleBar + TabNavigation in layout/)

### Deferred Ideas (OUT OF SCOPE)

- Multi-server functionality
- Individual screen redesigns (ServerPanel, RoutingPanel, SettingsPanel, etc.)
- Setup Wizard redesign
- Component naming audit
- Server button bugs, credentials persist, IP dedup, status re-render (screen-specific phases)
</user_constraints>

---

<phase_requirements>
## Phase Requirements

> NOTE: Requirements listed in REQUIREMENTS.md for Phase 4 (SCR-03 through SCR-09, DOC-04, DOC-05) were
> originally assigned when Phase 4 was "Remaining Panels" (7 screens). Per D-17/D-18 in CONTEXT.md, the
> scope is now "Application Shell" (WindowControls + TabNavigation + ServerSidebar). Those screen-level
> requirements are deferred to later phases. The planner should note this mismatch and plan only what
> CONTEXT.md defines.

| ID | Description | Research Support |
|----|-------------|------------------|
| SCR-03 | Setup Wizard redesign | DEFERRED — individual screen phase |
| SCR-04 | Settings Panel redesign | DEFERRED — individual screen phase |
| SCR-05 | Server Panel redesign (18 subcomponents) | DEFERRED — individual screen phase |
| SCR-06 | Routing Panel redesign | DEFERRED — individual screen phase |
| SCR-07 | Dashboard Panel redesign (or removal) | DEFERRED — Dashboard disbanded per D-04 |
| SCR-08 | Log Panel redesign | DEFERRED — LogPanel folded into Подключение per D-05 |
| SCR-09 | About Panel redesign | DEFERRED — individual screen phase |
| DOC-04 | memory/v3/use-cases/ — user scenarios per screen | Partial: use cases for shell navigation + server selection flow |
| DOC-05 | memory/v3/test-cases/ — positive + negative per screen | Partial: test cases for TabNavigation, WindowControls, ServerSidebar |

**What Phase 4 actually delivers (per CONTEXT.md):**
- `TitleBar` component (new) — logo + drag region + WindowControls
- `TabNavigation` component (new) — 5 horizontal tabs replacing Sidebar
- `WindowControls` redesign — token migration, title bar integration
- `ServerSidebar` redesign — token migration, visual polish
- `App.tsx` routing refactor — SidebarPage → AppTab, 8 pages → 5 tabs
- `ROADMAP.md` update — reflect new phase structure
- Storybook stories for all new/changed components
- DOC-04/DOC-05 coverage for shell-level use cases + test cases
</phase_requirements>

---

## Summary

Phase 4 delivers the application shell: the non-scrollable chrome that frames all content. This means three components get rebuilt or replaced — WindowControls (title bar buttons), the Sidebar (replaced entirely by TabNavigation), and ServerSidebar (redesigned with token migration). The App.tsx routing layer also requires a structural refactor from 8-page `SidebarPage` to 5-tab `AppTab`.

The UI-SPEC (04-UI-SPEC.md) was already created and approved before this research. It is the canonical source of truth for all visual decisions in this phase. Research confirms it is consistent with the existing codebase patterns established in Phases 1–3. The planner should treat UI-SPEC values as locked specs, not suggestions.

The key implementation risk is the `SidebarPage` → `AppTab` type rename: three files currently import `SidebarPage` (Sidebar.tsx, Sidebar.test.tsx, App.tsx), and `AppTab` in `shared/types.ts` is currently a deprecated stub with a different union shape. The type must be replaced cleanly, and Sidebar.test.tsx tests the old hover-expand behavior that will no longer exist — those tests must be rewritten for `TabNavigation`.

**Primary recommendation:** Proceed in this wave order — (1) ROADMAP update + new AppTab type + App.tsx routing refactor, (2) TitleBar + TabNavigation new components, (3) WindowControls redesign, (4) ServerSidebar token migration, (5) Storybook stories + i18n keys + docs. Each wave is independently testable.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | 19.x | UI rendering | Project standard — no change |
| lucide-react | existing | Icons in TabNavigation + ServerSidebar | Established Phase 2+ pattern |
| react-i18next | existing | `useTranslation()` hook for tab labels | Established pattern throughout codebase |
| CVA (class-variance-authority) | existing | Variant-based component styling | Established Phase 2 standard |
| Tailwind CSS | existing | Utility classes | Project standard |

[VERIFIED: codebase grep — all libraries confirmed in use in Sidebar.tsx, ServerSidebar.tsx, shared/ui/ components]

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @tauri-apps/api/window | existing | `getCurrentWindow()` for minimize/maximize/close | WindowControls only |
| cn() utility | existing | Merge Tailwind + conditional classes | Every new component |

### No New Dependencies
This phase installs zero new npm packages. All required building blocks exist: [VERIFIED: package.json and codebase scan confirm lucide-react, CVA, Tailwind, react-i18next are all installed]

**Version verification:** No version bumps needed. [VERIFIED: npm packages confirmed by codebase usage]

---

## Architecture Patterns

### Recommended Project Structure

```
gui-pro/src/
├── components/
│   └── layout/
│       ├── TitleBar.tsx          # NEW — logo + drag + WindowControls
│       ├── TabNavigation.tsx     # NEW — 5-tab horizontal nav
│       ├── WindowControls.tsx    # MODIFIED — token migration + TitleBar integration
│       └── Sidebar.tsx           # DELETED — replaced by TabNavigation
├── shared/
│   ├── types.ts                  # MODIFIED — AppTab type redefined
│   └── hooks/
│       └── useKeyboardShortcuts.ts  # MODIFIED — update pages array for 5 tabs
└── App.tsx                       # MODIFIED — routing refactor
```

[VERIFIED: directory structure confirmed by ls of gui-pro/src/components/layout/ and App.tsx]

### Pattern 1: TitleBar Component Structure

The title bar (32px, seamless background) wraps three zones:
1. Logo group (left): Shield icon + "TrustTunnel" text + "PRO" badge, all inside `data-tauri-drag-region`
2. Drag spacer (center): `flex-1`, `data-tauri-drag-region`
3. WindowControls (right): `WebkitAppRegion: "no-drag"` to allow button clicks

**Key constraint:** `data-tauri-drag-region` must NOT be on interactive elements (buttons). It belongs on the container div and the spacer. WindowControls wrapper already has `WebkitAppRegion: "no-drag"` — this pattern is established in the existing `WindowControls.tsx`. [VERIFIED: WindowControls.tsx line 14]

```typescript
// Source: App.tsx (current title bar pattern) + UI-SPEC.md Layout Architecture
// TitleBar.tsx
export function TitleBar({ hasUpdate }: { hasUpdate?: boolean }) {
  return (
    <div
      className="flex items-center shrink-0 h-8"
      data-tauri-drag-region
      style={{ backgroundColor: "var(--color-bg-primary)" }}
    >
      <div className="flex items-center gap-[var(--space-2)] pl-[var(--space-4)]" data-tauri-drag-region>
        {/* Shield logo + TrustTunnel + PRO badge */}
      </div>
      <div className="flex-1" data-tauri-drag-region />
      <WindowControls />
    </div>
  );
}
```

[VERIFIED: pattern derived from current App.tsx title bar block (lines 353–376) + UI-SPEC layout diagram]

### Pattern 2: TabNavigation — ARIA Tablist Pattern

The tab bar must use `role="tablist"` / `role="tab"` / `aria-selected` for keyboard accessibility (UI-SPEC Accessibility Contract). [VERIFIED: UI-SPEC.md Accessibility Contract section]

```typescript
// Source: UI-SPEC.md Accessibility Contract + WCAG tablist pattern
<div role="tablist" className="flex w-full h-10" style={{ backgroundColor: "var(--color-bg-primary)" }}>
  {TABS.map((tab) => (
    <button
      key={tab.id}
      role="tab"
      aria-selected={activeTab === tab.id}
      aria-disabled={tab.requiresConfig && !hasConfig}
      onClick={() => !isDisabled && onTabChange(tab.id)}
      className="relative flex-1 flex items-end justify-center pb-2 gap-[var(--space-1)]"
      // ... hover/active styles via token vars
    >
      {/* icon + label + 3px accent underline when active */}
    </button>
  ))}
</div>
```

**Arrow key navigation:** The `role="tablist"` pattern requires ArrowLeft/ArrowRight key handling for WCAG compliance. [ASSUMED — standard ARIA tablist keyboard pattern; not explicitly specified in UI-SPEC but implied by `role="tablist"` requirement]

### Pattern 3: Active Tab Indicator

UI-SPEC specifies a **centered 60%-width underline** at the bottom of the active tab, not a full background fill. This is a CSS absolute-position element:

```css
/* Source: UI-SPEC.md Component Inventory — TabNavigation */
position: absolute;
bottom: 0;
left: 50%;
transform: translateX(-50%);
width: 60%;
height: 3px;
background: var(--color-accent-interactive);
border-radius: var(--radius-full);
```

[VERIFIED: UI-SPEC.md TabNavigation section, Single tab anatomy]

### Pattern 4: SidebarPage → AppTab Migration

The type rename touches 4 locations:

| File | Change |
|------|--------|
| `shared/types.ts` | Replace deprecated `AppTab` stub with new 5-tab union |
| `components/layout/Sidebar.tsx` | Delete entire file (type exported here) |
| `App.tsx` | Import AppTab from types.ts, rename `activePage` state, update page routing logic |
| `shared/hooks/useKeyboardShortcuts.ts` | Update `pages` array from 8 items to 5 tab IDs |

The old `AppTab` in `shared/types.ts` is already marked `@deprecated`. [VERIFIED: shared/types.ts line 30-31] The new definition simply reuses the export name with the new union: `"control" | "connection" | "routing" | "settings" | "about"`.

**App.tsx routing refactor:** Currently uses `display: activePage === X ? "flex" : "none"` pattern with 7 page blocks. After Phase 4:
- `"server"` page block folds into `"control"` (ControlPanelPage handles the no-config SshConnectForm state internally — this behavior already exists per App.tsx line 398-420)
- `"dashboard"` block removed (DashboardPanel import + JSX deleted)
- `"logs"` block merged into `"connection"` rendering slot
- `"appSettings"` block renamed to `"settings"` slot

[VERIFIED: App.tsx reviewed — ControlPanelPage and SettingsPanel already handle conditional content internally]

### Pattern 5: ServerSidebar Token Migration

ServerSidebar has hardcoded Tailwind color classes for status dots. UI-SPEC provides exact replacement mapping: [VERIFIED: ServerSidebar.tsx lines 21-26 + UI-SPEC.md ServerSidebar redesign table]

| Element | Old class | New inline style |
|---------|-----------|-----------------|
| connected dot | `bg-emerald-400` | `background: var(--color-status-connected)` |
| connecting dot | `bg-amber-400 animate-pulse` | `background: var(--color-status-connecting)` + keep `animate-pulse` |
| disconnected dot | `bg-neutral-500` | `background: var(--color-status-disconnected)` |
| error dot | `bg-red-400` | `background: var(--color-status-error)` |
| disconnect hover | `hover:bg-red-500/20` | `hover:bg-[var(--color-status-error-bg)]` |
| disconnect icon | `text-red-400` | `color: var(--color-status-error)` |
| connecting spinner | `text-amber-400` | `color: var(--color-status-connecting)` |

### Pattern 6: WindowControls — Platform Exception for Close Button

The close button uses `#e81123` (hover) and `#c50f1f` (pressed) — Windows platform convention, NOT from design tokens. This is explicitly preserved from current implementation. A code comment MUST document this exception. [VERIFIED: WindowControls.tsx line 52 + UI-SPEC.md Close button hover exception section]

### Anti-Patterns to Avoid

- **Keeping `border-bottom` on title bar:** D-09 and UI-SPEC both specify seamless — no border-bottom separating title bar from tab bar.
- **Full-width background fill for active tab:** Use 3px accent underline only, not a filled background pill.
- **Setting `data-tauri-drag-region` on interactive elements:** Causes clicks to be intercepted by window drag. Logo container and spacer get the attribute; WindowControls wrapper explicitly unsets it.
- **Hardcoded hover RGBA in WindowControls:** Current code has `rgba(255,255,255,0.08)` — Phase 4 replaces with `var(--color-bg-hover)` for consistency in both themes.
- **Sidebar expand/collapse animation:** The sidebar is removed entirely; no slide animation on tab switch either.
- **Rendering ServerSidebar on non-control tabs:** UI-SPEC specifies control tab only.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Status dot colors | New color vars | Existing `--color-status-*` tokens | Already defined in tokens.css Tier 2 |
| Tab keyboard navigation | Custom key handler | Standard ARIA `role="tablist"` + ArrowKey event | WCAG standard, well-understood |
| Focus ring on tabs | Custom outline | `--focus-ring` token via `focus-visible:shadow-[var(--focus-ring)]` | Established Phase 2 pattern |
| Empty state in ServerSidebar | Inline div | `EmptyState` component from shared/ui/ | Phase 2 delivered EmptyState [VERIFIED: shared/ui/EmptyState.tsx] |
| i18n for new tab keys | Hardcoded strings | `useTranslation()` + keys in both locale JSONs | Established project pattern |

**Key insight:** Every visual building block already exists in the design system. Phase 4 is assembly + migration, not invention.

---

## Common Pitfalls

### Pitfall 1: SidebarPage Consumers in Test Files
**What goes wrong:** `Sidebar.test.tsx` imports `SidebarPage` type and tests hover-expand behavior. When Sidebar.tsx is deleted, the test file will fail to compile.
**Why it happens:** Test file imports from the component being deleted, not from shared/types.ts.
**How to avoid:** Replace `Sidebar.test.tsx` with `TabNavigation.test.tsx` — test the new component from scratch. The old hover-expand tests are irrelevant to the new tab model.
**Warning signs:** TypeScript error on `import type { SidebarPage } from "./Sidebar"` immediately after deletion.
[VERIFIED: Sidebar.test.tsx line 5 — confirmed import source]

### Pitfall 2: Header.tsx Still Uses Deprecated AppTab
**What goes wrong:** `Header.tsx` imports the old `AppTab` from `shared/types.ts` with the old 4-value union. When `AppTab` is redefined as the new 5-tab union, Header.tsx will have type errors.
**Why it happens:** Header.tsx was not updated when Sidebar.tsx took over navigation.
**How to avoid:** Check if Header.tsx is still in use. If it is, update its AppTab usage. If it's dead code, delete it.
**Warning signs:** `tsc --noEmit` will report type errors in Header.tsx after AppTab redefinition.
[VERIFIED: Header.tsx confirmed importing AppTab from shared/types.ts — Grep result line 2]

### Pitfall 3: App.tsx Keyboard Navigation Pages Array
**What goes wrong:** `useKeyboardShortcuts.ts` hardcodes `pages = ["dashboard", "server", "control", "settings", "routing", "logs", "appSettings", "about"]` (8 items). After Phase 4, Ctrl+1 through Ctrl+8 will navigate to pages that no longer exist.
**Why it happens:** The keyboard shortcut hook is not coupled to the navigation type — it uses a hardcoded string array.
**How to avoid:** Update `pages` array in `useKeyboardShortcuts.ts` to the new 5-tab IDs: `["control", "connection", "routing", "settings", "about"]`.
**Warning signs:** Ctrl+1 navigates to "dashboard" which is disbanded, causing silent no-op or React rendering a missing page.
[VERIFIED: useKeyboardShortcuts.ts line 19 — pages array confirmed]

### Pitfall 4: localStorage Page Persistence Uses Old IDs
**What goes wrong:** App.tsx persists `activePage` to `localStorage("tt_active_page")`. A user upgrading from v2.x could have `"server"`, `"dashboard"`, `"logs"`, or `"appSettings"` stored. On first launch after Phase 4, `activePage` would be set to an invalid AppTab value.
**Why it happens:** localStorage is persistent state that survives app restarts.
**How to avoid:** In App.tsx initial state function, expand the `pageMap` to also handle old IDs mapping to new AppTab values, or add a migration check that falls back to `"control"` for unknown values.
[VERIFIED: App.tsx lines 44-58 — pageMap already exists but only handles `"setup"`, `"settings"`, `"routing"`, `"about"`. Missing: `"server"→"control"`, `"dashboard"→"control"`, `"logs"→"connection"`, `"appSettings"→"settings"`, `"control"→"control"`]

### Pitfall 5: ControlPanelPage Expects ServerSidebar Inside It
**What goes wrong:** ServerSidebar is currently rendered inside `ControlPanelPage` (confirmed in CONTEXT.md code_context section). If Phase 4 lifts ServerSidebar to App.tsx shell level, ControlPanelPage may render a duplicate or break its layout expectations.
**Why it happens:** The server sidebar was co-located with the control panel in Phase 3.
**How to avoid:** Check ControlPanelPage.tsx for ServerSidebar import/usage before moving it to App.tsx shell. Either (a) remove it from ControlPanelPage and render it in App.tsx shell alongside ControlPanelPage, or (b) leave it in ControlPanelPage and let it manage its own sidebar. Verify which approach Phase 3 left it in.
[ASSUMED — exact ControlPanelPage ServerSidebar integration not confirmed by code read; CONTEXT.md says "ServerSidebar embedded in ControlPanelPage" but this needs verification at plan time]

### Pitfall 6: Storybook Stories for Layout Components Need Data-Tauri-Drag-Region Handling
**What goes wrong:** Storybook renders in a browser iframe, not a Tauri window. `data-tauri-drag-region` is harmless as an attribute, but trying to demonstrate "drag" behavior in a story is meaningless and may confuse reviewers.
**Why it happens:** TitleBar story must show the component but cannot demonstrate actual window dragging.
**How to avoid:** Storybook stories for TitleBar should add a note in the story description. The attribute is a DOM data attribute and won't cause any crash — stories still pass.
[VERIFIED: existing `.storybook/tauri-mocks/` directory confirms Tauri mocking is already established]

---

## Code Examples

Verified patterns from official sources:

### WindowControls — Token Migration (before/after)

```typescript
// Source: WindowControls.tsx (current) + UI-SPEC.md WindowControls redesign
// BEFORE (hardcoded RGBA):
style={{ background: hovered === "min" ? "rgba(255,255,255,0.08)" : "transparent" }}

// AFTER (design token via Tailwind):
className={cn(
  "h-full w-10 flex items-center justify-center transition-colors duration-[var(--transition-fast)]",
  hovered === "min" ? "bg-[var(--color-bg-hover)]" : "bg-transparent"
)}
```

### Tab Definitions Array

```typescript
// Source: UI-SPEC.md Tab definitions table
import { Monitor, Settings, GitBranch, SlidersHorizontal, Info } from "lucide-react";

export type AppTab = "control" | "connection" | "routing" | "settings" | "about";

interface TabDef {
  id: AppTab;
  labelKey: string;
  icon: ReactNode;
  requiresConfig: boolean;
}

const TABS: TabDef[] = [
  { id: "control",    labelKey: "tabs.controlPanel", icon: <Monitor className="w-4 h-4" />,           requiresConfig: false },
  { id: "connection", labelKey: "tabs.connection",   icon: <Settings className="w-4 h-4" />,           requiresConfig: true },
  { id: "routing",    labelKey: "tabs.routing",      icon: <GitBranch className="w-4 h-4" />,          requiresConfig: true },
  { id: "settings",   labelKey: "tabs.settings",     icon: <SlidersHorizontal className="w-4 h-4" />,  requiresConfig: true },
  { id: "about",      labelKey: "tabs.about",        icon: <Info className="w-4 h-4" />,               requiresConfig: false },
];
```

### i18n Keys — New and Changed

```json
// Source: en.json (current) + UI-SPEC.md Copywriting Contract
// CURRENT tabs object has: server, serverSetup, installation, controlPanel, appSettings,
//   settings (="VPN Settings"), dashboard, routing, logs, about, setup
// AFTER Phase 4, add/update:
{
  "tabs": {
    "connection": "Connection",       // NEW — replaces old "settings"="VPN Settings"
    "settings": "Settings",           // EXISTING "appSettings" renamed to "settings"
    "controlPanel": "Control Panel",  // EXISTING — no change
    "routing": "Routing",             // EXISTING — no change
    "about": "About",                 // EXISTING — no change
    "requires_config": "Set up connection first"  // NEW — disabled tab tooltip
  },
  "sidebar": {
    "no_servers_hint": "Configure connection in Control Panel"  // NEW — EmptyState body
  }
}
```

[VERIFIED: en.json and ru.json first 40 lines — existing keys confirmed; new keys derived from UI-SPEC Copywriting Contract]

### App.tsx localStorage Migration Guard

```typescript
// Source: App.tsx lines 43-58 (current) + Pitfall 4 analysis
const [activeTab, setActiveTab] = useState<AppTab>(() => {
  const saved = localStorage.getItem("tt_active_page") || localStorage.getItem("tt_active_tab");
  const savedConfig = localStorage.getItem("tt_config_path");

  // Map ALL old IDs (including pre-Phase-4 SidebarPage values) to new AppTab
  const tabMap: Record<string, AppTab> = {
    // Old SidebarPage IDs → new AppTab
    server: "control",
    control: "control",
    settings: "connection",      // old "VPN settings" → "connection" tab
    appSettings: "settings",     // old "App settings" → "settings" tab
    dashboard: "control",
    routing: "routing",
    logs: "connection",
    about: "about",
    // New AppTab IDs (passthrough for forward compat)
    connection: "connection",
  };

  const mapped = saved ? (tabMap[saved] ?? "control") : null;
  if (savedConfig && mapped) return mapped;
  if (savedConfig) return "connection";
  return "control";
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hover-expand sidebar (Sidebar.tsx) | Horizontal top tab bar (TabNavigation.tsx) | Phase 4 | Sidebar.tsx deleted entirely |
| 8 navigation pages (SidebarPage union) | 5 tabs (AppTab union) | Phase 4 | type redefined in shared/types.ts |
| Dashboard as separate screen | Data redistributed to Панель управления + Подключение | Phase 4 | DashboardPanel import + routing block removed from App.tsx |
| LogPanel as separate page | Folded into Подключение tab | Phase 4 | logs page block merged into connection rendering slot |
| Hardcoded RGBA hover in WindowControls | Token-based hover colors | Phase 4 | Light theme now shows correct light hover |
| Hardcoded Tailwind status colors in ServerSidebar | `--color-status-*` semantic tokens | Phase 4 | Status dots respect theme correctly |

**Deprecated/outdated:**
- `Sidebar.tsx` + `SidebarPage` type: deleted in Phase 4
- `AppTab` in shared/types.ts (old 4-value stub): replaced with new 5-tab union
- `DashboardPanel` usage in App.tsx: routing block removed (component file may be kept for future or deleted — decision for plan)
- Keyboard shortcut `pages` array with 8 entries: updated to 5-tab IDs

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Arrow key navigation (ArrowLeft/ArrowRight) is required for ARIA tablist compliance | Architecture Patterns — Pattern 2 | If skipped, a11y audit in Phase 6 will flag it; low execution risk, can be added later |
| A2 | ControlPanelPage currently embeds ServerSidebar as an internal child (not App.tsx shell) | Common Pitfalls — Pitfall 5 | Plan may need adjustment after verifying ControlPanelPage.tsx; if already at App.tsx level, no lift needed |
| A3 | DashboardPanel component file should be kept (not deleted) pending future screen phases | App.tsx routing section | If deleted, requires recreating in a later phase; safe to keep as dead import until Phase 6 cleanup |

---

## Open Questions (RESOLVED)

1. **ControlPanelPage.tsx — is ServerSidebar inside it or already at App.tsx level?** (RESOLVED)
   - **Answer:** ServerSidebar stays inside ControlPanelPage. Verified by reading ControlPanelPage.tsx — it embeds ServerSidebar as an internal child. Plan 05 only modifies ServerSidebar.tsx in-place (token migration); it does NOT lift ServerSidebar to App.tsx. No "lift to shell" task is needed.

2. **DashboardPanel: delete file or just remove routing block?** (RESOLVED)
   - **Answer:** Remove the DashboardPanel import from App.tsx (Plan 05 Task 1 action removes `import DashboardPanel`). The DashboardPanel.tsx file itself is kept for potential Phase 6 cleanup — phase scope is shell only. File is not deleted in Phase 4.

3. **ROADMAP.md update content — how many new phases?** (RESOLVED)
   - **Answer:** 4 plans listed for Phase 4 (04-03 through 04-06). Phases 5 (Layout Shell) and 6 (Cleanup) remain unchanged. No new phase numbers are added for deferred screen migrations — those will be created when their phases are discussed via `/gsd-discuss-phase`.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 4 is purely frontend code changes. No external tools, databases, CLIs, or services required beyond the existing dev environment (Node.js, npm, Rust/cargo — all confirmed available by prior phases).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest + @testing-library/react |
| Config file | `gui-pro/vite.config.ts` (vitest config inline) |
| Quick run command | `npm test` (from gui-pro/) |
| Full suite command | `npm test` (runs all 83+ tests) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TabNavigation | 5 tabs render, active state, disabled state | unit | `npm test -- TabNavigation` | ❌ Wave 0 |
| TabNavigation | hasConfig=false disables 3 tabs | unit | `npm test -- TabNavigation` | ❌ Wave 0 |
| TabNavigation | tab click calls onTabChange | unit | `npm test -- TabNavigation` | ❌ Wave 0 |
| WindowControls | 3 buttons render with aria-labels | unit | `npm test -- WindowControls` | ❌ Wave 0 |
| ServerSidebar | status dots use token vars | unit | `npm test -- ServerSidebar` | ❌ Wave 0 |
| App.tsx (routing) | activePage localStorage migration (old IDs → new AppTab) | unit | `npm test -- App` | Partial (no existing App.test.tsx) |
| Sidebar.test.tsx | Old hover-expand tests for deleted component | REMOVE | — | Must delete/replace |

### Sampling Rate
- **Per task commit:** `npm run typecheck && npm test`
- **Per wave merge:** `npm run typecheck && npm run lint && npm test`
- **Phase gate:** Full `npm run prerelease` green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `gui-pro/src/components/layout/TabNavigation.test.tsx` — covers tab rendering, active state, disabled state, click handler
- [ ] `gui-pro/src/components/layout/TitleBar.test.tsx` — covers TitleBar renders Shield icon, TrustTunnel text, PRO badge, no border-bottom, imports WindowControls
- [ ] Replace `gui-pro/src/components/layout/Sidebar.test.tsx` → either delete alongside Sidebar.tsx deletion or clear and rename

*(Sidebar.test.tsx tests are entirely invalidated by the component deletion. The planner must include its deletion as a task.)*

---

## Security Domain

Phase 4 is a pure frontend visual/layout refactor with zero backend changes, no new data inputs, no authentication flows, and no network requests. ASVS categories V2 (Authentication), V3 (Session Management), V4 (Access Control), and V6 (Cryptography) are not applicable. V5 (Input Validation) has no new inputs. No security domain research required.

---

## Sources

### Primary (HIGH confidence)
- `04-UI-SPEC.md` — Full visual contract for all Phase 4 components (verified by codebase read)
- `04-CONTEXT.md` — All locked decisions D-01 through D-19 (verified by file read)
- `gui-pro/src/components/layout/Sidebar.tsx` — Current sidebar implementation (verified by file read)
- `gui-pro/src/components/layout/WindowControls.tsx` — Current WindowControls (verified by file read)
- `gui-pro/src/components/ServerSidebar.tsx` — Current ServerSidebar (verified by file read)
- `gui-pro/src/App.tsx` — Routing structure, SidebarPage usage, title bar current state (verified by file read)
- `gui-pro/src/shared/styles/tokens.css` — Full token inventory (verified by file read)
- `gui-pro/src/shared/types.ts` — AppTab deprecated stub, SidebarPage dependency (verified by file read)
- `gui-pro/src/shared/hooks/useKeyboardShortcuts.ts` — Hardcoded pages array (verified by file read)
- `gui-pro/src/shared/i18n/locales/en.json` + `ru.json` — Existing tabs keys (verified by partial read)
- `gui-pro/src/components/layout/Sidebar.test.tsx` — Tests to be replaced (verified by file read)

### Secondary (MEDIUM confidence)
- `gui-pro/src/shared/ui/EmptyState.tsx` — Confirmed EmptyState API for ServerSidebar empty state
- `gui-pro/src/shared/ui/` directory listing — Confirmed Phase 2 component inventory is complete

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified by codebase
- Architecture: HIGH — patterns derived directly from UI-SPEC and existing code
- Pitfalls: HIGH — verified against actual code (specific line numbers cited for each)
- Assumptions: 3 flagged, all LOW risk

**Research date:** 2026-04-14
**Valid until:** 2026-05-14 (stable design system, 30-day window)
