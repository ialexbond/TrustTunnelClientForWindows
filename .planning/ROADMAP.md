# Roadmap: TrustTunnel v3.0 BigTech Production Redesign

## Overview

Milestone v3.0 transforms TrustTunnel Pro from vibe-coded UI to a contract-built design system. The journey begins with token consolidation and Storybook infrastructure, progresses through primitive component redesign, then migrates each screen using the proven system, and ends with layout shell and cleanup. Every phase is verifiable in isolation: Storybook is the source of truth throughout.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation** - Token consolidation + Storybook infrastructure, zero component changes
- [ ] **Phase 2: Primitive Redesign** - All 19 existing + new primitive components redesigned in Storybook
- [ ] **Phase 3: Control Panel** - First screen migration, proves the design system works end-to-end
- [ ] **Phase 4: Application Shell** - TitleBar, TabNavigation (5 tabs replacing sidebar), ServerSidebar redesign, App.tsx routing refactor
- [ ] **Phase 5: Layout Shell** - Sidebar and WindowControls (last, frames everything)
- [ ] **Phase 6: Cleanup** - Remove legacy artifacts, enforce quality gates, finalize cross-references

## Phase Details

### Phase 1: Foundation
**Goal**: Design system token architecture is complete and Storybook renders real components with full theming — no component changes yet
**Depends on**: Nothing (first phase)
**Requirements**: DS-01, DS-02, DS-03, DS-04, DS-05, DS-06, DS-07, DS-08, DS-11, SB-01, SB-02, SB-03, SB-06, SB-07, SB-08, SB-09, QA-01, QA-03, DOC-01, DOC-07
**Success Criteria** (what must be TRUE):
  1. Storybook opens and renders any existing component with correct dark and light theme via toolbar toggle — no crash on Tauri API imports
  2. tokens.css contains two-tier token architecture (primitives + semantics) including typography, spacing, z-index, focus ring, status, and glow/shadow scales with new accent colors
  3. All light/dark theme switching is driven entirely by tokens.css — the [data-theme] overrides in index.css are eliminated
  4. Theme flash is gone: the app applies the correct theme before React mounts (inline script in index.html)
  5. Storybook HMR works, scaffold stories are removed, and Foundations MDX pages (Colors, Typography, Spacing, Shadows) are visible
**Plans**: 5 plans
Plans:
- [x] 01-01-PLAN.md — Version bump (executed instead of token work)
- [x] 01-02-PLAN.md — Storybook 10 setup + Tauri mocks + HMR + scaffold removal
- [x] 01-03-PLAN.md — MDX Foundations pages + memory/v3/ documentation + checkpoint
- [x] 01-04-PLAN.md — [GAP CLOSURE] tokens.css two-tier architecture with slate-teal accent and all scales
- [x] 01-05-PLAN.md — [GAP CLOSURE] index.css cleanup + colors.ts deprecation + theme flash + memory/v3/ docs
**UI hint**: yes

### Phase 2: Primitive Redesign
**Goal**: All shared/ui/ primitives (existing and new) use only token variables, have CVA variants where specified, and are documented with full-state Storybook stories
**Depends on**: Phase 1
**Requirements**: COMP-01, COMP-02, COMP-03, COMP-04, COMP-05, COMP-06, COMP-07, COMP-08, COMP-09, COMP-10, COMP-11, COMP-12, COMP-13, COMP-14, SB-04, SB-05, DOC-02
**Success Criteria** (what must be TRUE):
  1. Every primitive in shared/ui/ renders in Storybook with zero hardcoded colors — only CSS custom property vars
  2. Button, Badge, and ErrorBanner show CVA variants (primary/danger/ghost/icon, success/warning/danger/neutral/dot, severity) with all sizes in Storybook
  3. The 7 new components (Section, FormField, StatusBadge, EmptyState, Separator, ProgressBar, and custom Select/dropdown) exist in shared/ui/ with stories showing all states
  4. Every component story demonstrates default, hover, focus, active, disabled, and error states in both themes
  5. memory/v3/design-system/ contains component documentation for all primitives (props, variants, states, dependencies)
**Plans**: 7 plans
Plans:
- [ ] 02-01-PLAN.md — CVA infrastructure + Button/Badge/ErrorBanner redesign with stories
- [ ] 02-02-PLAN.md — Input family redesign (Input + NumberInput + PasswordInput + ActionInput + ActionPasswordInput)
- [ ] 02-03-PLAN.md — Modal/ConfirmDialog/Toggle/Card/Tooltip redesign with stories
- [ ] 02-04-PLAN.md — Select/SnackBar/IconButton/DropOverlay/PanelErrorBoundary redesign
- [ ] 02-05-PLAN.md — New components: Section, FormField, StatusBadge, EmptyState
- [ ] 02-06-PLAN.md — New components: Separator, ProgressBar
- [ ] 02-07-PLAN.md — Barrel exports, component documentation, Storybook visual checkpoint
**UI hint**: yes

### Phase 3: Control Panel
**Goal**: Control Panel and StatusPanel are fully migrated to the new design system, serving as the proof-of-concept that the token + component system works on a real screen
**Depends on**: Phase 2
**Requirements**: SCR-01, SCR-02, DOC-03
**Success Criteria** (what must be TRUE):
  1. Control Panel renders in the running app using only new primitives and semantic tokens — no legacy hardcoded styles
  2. StatusPanel displays VPN state using StatusBadge and status semantic tokens in both light and dark themes
  3. Control Panel has a Storybook story with Tauri mocked, showing all VPN states (connected, connecting, error, disconnected)
  4. memory/v3/screens/ contains the behavior specification for Control Panel
**Plans**: TBD
**UI hint**: yes

### Phase 4: Application Shell
**Goal**: Application shell is complete: TitleBar (custom title bar with logo + WindowControls), TabNavigation (5 horizontal tabs replacing sidebar), ServerSidebar redesigned with tokens, and App.tsx routing refactored from 8 SidebarPage to 5 AppTab
**Depends on**: Phase 3
**Requirements**: SCR-07 (partial — Dashboard disbanded), DOC-04 (partial — shell use cases), DOC-05 (partial — shell test cases). SCR-03, SCR-04, SCR-05, SCR-06, SCR-08, SCR-09 deferred to future screen phases.
**Success Criteria** (what must be TRUE):
  1. TitleBar renders seamlessly (no border-bottom) with logo + drag region + WindowControls in both themes
  2. TabNavigation shows 5 tabs with correct disabled states when hasConfig=false, ARIA tablist semantics
  3. ServerSidebar uses only design token vars for status dots and hover states — zero hardcoded Tailwind colors
  4. App.tsx routing uses AppTab 5-tab union, old localStorage page IDs migrate correctly
  5. Sidebar.tsx is deleted, all navigation goes through TabNavigation
**Plans**: 4 plans
Plans:
- [ ] 04-03-PLAN.md — Foundation: AppTab type + i18n keys + keyboard shortcuts + ROADMAP update
- [ ] 04-04-PLAN.md — New components: TitleBar + TabNavigation + WindowControls redesign
- [ ] 04-05-PLAN.md — Integration: App.tsx refactor + ServerSidebar redesign + Sidebar deletion
- [ ] 04-06-PLAN.md — Polish: Storybook stories + documentation + visual checkpoint
**UI hint**: yes

### Phase 5: Layout Shell
**Goal**: Sidebar navigation and WindowControls (custom title bar) are redesigned — the last pieces that frame the entire application
**Depends on**: Phase 4
**Requirements**: SCR-10, SCR-11
**Success Criteria** (what must be TRUE):
  1. Sidebar renders with the new design, correct token-based active/hover states, and functions correctly in both light and dark themes
  2. WindowControls (minimize, maximize, close) render with redesigned styling using token vars and function correctly as a custom title bar
  3. The full application looks visually cohesive end-to-end — Sidebar + all panels + WindowControls form one unified design system
**Plans**: TBD
**UI hint**: yes

### Phase 6: Cleanup
**Goal**: All legacy artifacts are removed (colors.ts, surface.* palette, !important overrides), quality gates pass, and documentation cross-references are complete
**Depends on**: Phase 5
**Requirements**: DS-09, DS-10, SCR-12, QA-02, QA-04, QA-05, DOC-06
**Success Criteria** (what must be TRUE):
  1. colors.ts no longer exists — every value is a CSS custom property in tokens.css
  2. surface.* palette is removed from tailwind.config.js — Tailwind uses only semantic aliases via CSS vars
  3. All 38 !important overrides are removed from index.css — specificity is resolved through token architecture
  4. vitest-axe a11y tests run in CI and pass; all 83+ behavioral tests continue to pass
  5. Every screen has a Storybook story, and memory/v3/ documentation has complete cross-references (screen → components → use cases → test cases)
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 5/5 | Complete | - |
| 2. Primitive Redesign | 0/7 | Planned | - |
| 3. Control Panel | 0/TBD | Not started | - |
| 4. Application Shell | 0/4 | Not started | - |
| 5. Layout Shell | 0/TBD | Not started | - |
| 6. Cleanup | 0/TBD | Not started | - |
