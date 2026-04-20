# Phase 1: Foundation - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 delivers the design system token architecture and Storybook infrastructure — the foundation everything else builds on. Zero component changes. Specifically:

- Two-tier CSS token system (primitives + semantics) in tokens.css
- Complete token scales: colors, typography, spacing, z-index, focus ring, status, shadows
- New accent colors and theme palettes (DS-11)
- Theme flash prevention (QA-01)
- Storybook fully operational with theme toggle, Tauri mocks, Foundations MDX pages
- Existing 83+ tests continue passing (QA-03)
- Documentation in memory/v3/design-system/

</domain>

<decisions>
## Implementation Decisions

### Visual Direction
- **D-01:** Absolutely new design approach — NOT an evolution of v2. New principles, new concept, new colors
- **D-02:** Mood: restrained elegance (сдержанная элегантность). Near-monochrome system. No bright colors, muted tones, high contrast
- **D-03:** Reference style: Linear, Raycast, Apple System Prefs — premium professional tool feel
- **D-04:** Anti-pattern: must NOT look AI-generated, must NOT repeat v2 indigo identity

### Color Palette
- **D-05:** Accent color — Claude's discretion. Must NOT be indigo (v2 accent). Must feel professional and pleasant on neutral background
- **D-06:** Status colors mandatory in token system: success (green shades), error (red shades), warning (amber shades), info (blue shades)
- **D-07:** Dark theme: neutral deep gray / near-black background. NO blue undertone (current #0a0a0f has blue — must change). High contrast between bg and text
- **D-08:** Light theme: warm cream (~#fafaf8 area). Must match dark theme in readability — all text, buttons, controls must be clear on fast theme switch
- **D-09:** Both themes must feel like one cohesive system with strong contrast between each other

### Token Scales
- **D-10:** Spacing, typography, shadow scale granularity — Claude's discretion, sized for the app's 32 existing components

### Storybook Foundations
- **D-11:** Full MDX documentation pages: Colors, Typography, Spacing, Shadows — with visual previews of all tokens
- **D-12:** Storybook is the approval tool: user tests/approves components there before they go into the app. Phase 1 sets up the infrastructure for this workflow.

### Effects
- **D-13:** Minimal effects — remove all glow (successGlow, dangerGlow, accentLogoGlow from colors.ts). Shadows only, no glow. Aligns with restrained elegance direction.

### Claude's Discretion
- Token scale granularity (spacing steps, typography sizes, shadow levels) — pick what fits 32 components
- Specific accent color choice — not indigo, professional, pleasant
- Storybook MDX page format and depth — practical for solo developer

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design Philosophy
- `memory/decisions/v3-philosophy.md` — Contract-first development process: design → spec → docs → code → tests
- `memory/decisions/v3-design-guidelines.md` — Visual direction, screen scope, Pro/Lite relationship, anti-patterns
- `memory/decisions/v3-documentation-structure.md` — memory/v3/ structure and cross-references

### Existing Code (current state to transform FROM)
- `gui-pro/src/shared/styles/tokens.css` — Current v2 tokens (to be replaced/expanded)
- `gui-pro/src/shared/ui/colors.ts` — Hardcoded RGBA values (glow/shadow) to migrate to tokens
- `gui-pro/src/index.css` — 38 !important overrides + [data-theme] blocks (Phase 6 removes, but tokens must be ready)
- `gui-pro/tailwind.config.js` — surface.* palette (Phase 6 removes)
- `gui-pro/index.html` — Needs inline theme script (QA-01)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `tokens.css` — Has basic structure (accent, bg, text, border, input, shadow vars). Must be expanded, NOT deleted and recreated — add missing scales on top
- 19 UI components in `shared/ui/` — NOT touched in Phase 1, but token names must be backward-compatible until Phase 2 migrates them

### Established Patterns
- CSS custom properties via `var()` — already used everywhere, good foundation
- Tailwind utility classes — coexist with custom properties
- `[data-theme]` selector for theme switching — will be enhanced, not changed

### Integration Points
- `index.html` — needs inline script for theme flash prevention before React mount
- `gui-pro/package.json` — needs Storybook dependencies
- `gui-pro/.storybook/` — needs to be created from scratch (currently no Storybook setup)
- `gui-pro/vite.config.ts` — Storybook viteFinal must override HMR:false and add Tauri API mock aliases

</code_context>

<specifics>
## Specific Ideas

- User explicitly wants near-monochrome (B&W) system with minimal color
- Dark theme should feel "expensive" (дорогой) — deep neutral without color tint
- Light theme warm cream, not cold white or blue-gray
- User confirmed Phase 3 screen = Control Panel (connection screen) — existing roadmap order is correct
- User unfamiliar with Storybook — Foundations pages serve as both development tool and introduction to the design system
- "Должно быть максимально просто по цветам и сдержанно" — simplicity is a core value, not just a preference

</specifics>

<deferred>
## Deferred Ideas

- User wants to see all Control Panel components in Storybook — Phase 2 (primitives) + Phase 3 (screen migration)
- "Настройки VPN" panel mentioned — clarified as Server Panel, stays in Phase 4 per roadmap

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-infrastructure-release-setup*
*Context gathered: 2026-04-13*
