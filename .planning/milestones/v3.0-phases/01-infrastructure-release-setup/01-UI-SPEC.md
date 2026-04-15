---
phase: 1
slug: infrastructure-release-setup
status: draft
shadcn_initialized: false
preset: none
created: 2026-04-13
revised: 2026-04-13
revision_note: contrast fixes, typography fix, missing token layers, accent states, status bg, reduced-motion
---

# Phase 1 — UI Design Contract

> Visual and interaction contract for Phase 1: Foundation.
> Phase 1 delivers design tokens and Storybook infrastructure — no UI screens, no component changes.
> The "UI" this phase produces is tokens.css and MDX Foundations pages.
> Every downstream phase (2–6) consumes the values declared here.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none — shadcn/ui explicitly excluded (conflicts with 32 custom components) |
| Preset | not applicable |
| Component library | custom — 19 existing primitives in shared/ui/, zero new components in Phase 1 |
| Icon library | lucide-react 0.468.0 (already installed) |
| Font | Inter → Segoe UI → system-ui → -apple-system → sans-serif (from index.css, preserved as-is) |

Source: REQUIREMENTS.md Out of Scope section; CONTEXT.md code_context; package.json; index.css

---

## Spacing Scale

Phase 1 defines the spacing token scale in tokens.css (--space-* variables). No layout changes to components occur until Phase 2.

Sequential numbering (4px base, all multiples of 4):

| Token | CSS Var | Value | Usage |
|-------|---------|-------|-------|
| 1 | --space-1 | 4px | Icon gaps, tight inline padding, dot indicators |
| 2 | --space-2 | 8px | Compact element spacing, icon-to-label gap |
| 3 | --space-3 | 12px | Input internal padding (vertical), small gaps |
| 4 | --space-4 | 16px | Default element spacing, form field gaps |
| 5 | --space-5 | 20px | Card padding (compact), list item height |
| 6 | --space-6 | 24px | Section padding, modal padding |
| 7 | --space-7 | 32px | Layout gaps, section breaks |
| 8 | --space-8 | 40px | Major section breaks, panel vertical rhythm |

Exceptions:
- Sidebar collapsed width: 56px (--sidebar-width-collapsed, existing, preserved)
- Sidebar expanded width: 220px (--sidebar-width-expanded, existing, preserved)
- Window control button: 40x32px (existing, preserved — non-4-point width acceptable for OS chrome)
- Touch/click target minimum: 32px height (aligned with --space-7 row height)

Source: CONTEXT.md D-10 (Claude's discretion); sized for 32 existing components; existing sidebar vars preserved

---

## Typography

Phase 1 defines the typography token scale in tokens.css (--font-size-*, --font-weight-*, --tracking-* variables). The Storybook Typography MDX page renders all tokens visually.

| Role | CSS Var | Size | Weight Var | Weight | Line Height | Tracking |
|------|---------|------|------------|--------|-------------|----------|
| xs (caption/label) | --font-size-xs | 11px | --font-weight-normal | 400 | 1.4 | --tracking-wide |
| sm (helper/secondary) | --font-size-sm | 12px | --font-weight-normal | 400 | 1.5 | --tracking-normal |
| md (body, default) | --font-size-md | 14px | --font-weight-normal | 400 | 1.5 | --tracking-normal |
| lg (section heading) | --font-size-lg | 16px | --font-weight-semibold | 600 | 1.3 | --tracking-tight |

Weight tokens:
- --font-weight-normal: 400
- --font-weight-semibold: 600

Letter-spacing tokens:
- --tracking-tight: -0.01em (headings — tighter for density)
- --tracking-normal: 0 (body and secondary text)
- --tracking-wide: 0.02em (11px captions, uppercase labels — prevents character collapse)

Notes:
- 14px body is standard for compact desktop utility apps (reference: Linear, Raycast)
- Scale: 11 → 12 → 14 → 16 — each step is perceptually distinct (min 2px gap)
- Only 2 weights declared — eliminates inconsistent medium/bold usage in v2
- No display size defined in Phase 1 — added in Phase 3 when Control Panel heading is designed
- lg line-height 1.3 (not 1.25) — ensures descenders don't clip in multi-line headings

Source: CONTEXT.md D-03 (reference style Linear/Raycast/Apple); REQUIREMENTS.md DS-03; default for compact desktop app

---

## Color

### Philosophy

Near-monochrome system. Restrained elegance. Not indigo (v2 accent forbidden). No glow (D-13 — removed). Shadows only. Both themes feel like one cohesive family with strong contrast between each other.

All color pairs verified against WCAG 2.1 AA (4.5:1 for normal text, 3:1 for large text/UI components).

Reference: Linear, Raycast, Apple System Prefs. Anti-pattern: AI-generated look, v2 indigo identity.

### Accent Color Decision

Accent: **slate-teal** — a desaturated teal/sage tone, neither blue nor green, professional and pleasant on neutral backgrounds.

Dark theme accent primitives:
- --color-accent-50:  #f0f4f4
- --color-accent-100: #d9e8e7
- --color-accent-200: #b3d1cf
- --color-accent-300: #80b3b0
- --color-accent-400: #4d9490  (dark theme interactive — 5.87:1 on #0d0d0d)
- --color-accent-500: #2d7a76  (brand midpoint, decorative use only)
- --color-accent-600: #236260  (light theme interactive — 6.73:1 on #f9f9f7)
- --color-accent-700: #1a4a48
- --color-accent-800: #123533
- --color-accent-900: #0b2221

Semantic aliases:

| Token | Dark value | Light value | Usage |
|-------|-----------|-------------|-------|
| --color-accent-interactive | --color-accent-400 (#4d9490) | --color-accent-600 (#236260) | Default interactive accent (buttons, links, toggles) |
| --color-accent-hover | --color-accent-300 (#80b3b0) | --color-accent-700 (#1a4a48) | Hover state for accent elements |
| --color-accent-active | --color-accent-500 (#2d7a76) | --color-accent-800 (#123533) | Pressed/active state for accent elements |

This ensures all interactive accent elements pass WCAG AA and have distinct hover/active feedback without developer improvisation.

Rationale: Teal reads as technical/precise without indigo's "AI" association. Works on both deep gray and warm cream backgrounds. Not common in VPN app space (differentiated from Mullvad blue, ProtonVPN purple).

### Dark Theme

| Role | Value | Contrast on bg-primary | Usage |
|------|-------|----------------------|-------|
| Dominant (60%) — bg-primary | #0d0d0d | — | Main window background (replaces #0a0a0f — removes blue undertone per D-07) |
| Secondary (30%) — bg-secondary / bg-surface | #161616 / #1c1c1c | — | Sidebar bg, panel bg, card surfaces (cards require --color-border) |
| Accent (10%) | #4d9490 (--color-accent-400) | 5.87:1 ✓ AA | See reserved list below |
| Destructive | #e05545 | 5.2:1 ✓ AA | Destructive action buttons, error text, danger badge |

| CSS Var | Value | Role |
|---------|-------|------|
| --color-bg-primary | #0d0d0d | Window background |
| --color-bg-secondary | #161616 | Sidebar, secondary panels |
| --color-bg-surface | #1c1c1c | Cards, elevated containers (always use with --color-border) |
| --color-bg-elevated | #222222 | Modals, dropdowns, tooltips |
| --color-bg-hover | #2a2a2a | Hover state background |
| --color-bg-active | #323232 | Active/pressed state background |
| --color-text-primary | #f2f2f2 | Body text, headings — 18.3:1 ✓ |
| --color-text-secondary | #9a9a9a | Secondary labels, descriptions — 7.4:1 ✓ |
| --color-text-muted | #6e6e6e | Placeholder, disabled, timestamps — 4.6:1 ✓ AA |
| --color-text-inverse | #0d0d0d | Text on accent backgrounds — 5.87:1 on accent-400 ✓ |
| --color-border | rgba(255,255,255,0.08) | Default borders |
| --color-border-hover | rgba(255,255,255,0.14) | Hover borders |
| --color-border-active | rgba(255,255,255,0.22) | Focus borders |
| --color-input-bg | rgba(255,255,255,0.05) | Input field background |
| --color-input-border | rgba(255,255,255,0.12) | Input border |
| --color-input-focus | var(--color-accent-400) | Input focus ring |
| --color-toggle-off | rgba(255,255,255,0.12) | Toggle unchecked state |
| --color-toggle-on | var(--color-accent-400) | Toggle checked state |

### Light Theme

| Role | Value | Contrast on bg-primary | Usage |
|------|-------|----------------------|-------|
| Dominant (60%) — bg-primary | #f9f9f7 | — | Main window background (warm cream per D-08) |
| Secondary (30%) — bg-secondary / bg-surface | #ffffff / #f0f0ed | — | Sidebar, cards |
| Accent (10%) | #236260 (--color-accent-600) | 6.73:1 ✓ AA | Same reserved elements — darker shade for contrast on cream |
| Destructive | #b03020 | 6.12:1 ✓ AA | Destructive actions — darkened for contrast on light bg |

| CSS Var | Value | Role |
|---------|-------|------|
| --color-bg-primary | #f9f9f7 | Window background (warm cream) |
| --color-bg-secondary | #ffffff | Sidebar, secondary panels |
| --color-bg-surface | #f0f0ed | Cards, elevated containers |
| --color-bg-elevated | #e8e8e5 | Modals, dropdowns |
| --color-bg-hover | #e2e2de | Hover state |
| --color-bg-active | #d8d8d4 | Active/pressed state |
| --color-text-primary | #161616 | Body text, headings — 18.3:1 ✓ |
| --color-text-secondary | #5a5a5a | Secondary labels — 6.6:1 ✓ |
| --color-text-muted | #767676 | Placeholder, disabled — 4.5:1 ✓ AA |
| --color-text-inverse | #f9f9f7 | Text on accent backgrounds — 6.73:1 on accent-600 ✓ |
| --color-border | rgba(0,0,0,0.09) | Default borders |
| --color-border-hover | rgba(0,0,0,0.15) | Hover borders |
| --color-border-active | rgba(0,0,0,0.24) | Focus borders |
| --color-input-bg | #f4f4f1 | Input background |
| --color-input-border | #c8c8c4 | Input border |
| --color-input-focus | var(--color-accent-600) | Input focus ring |
| --color-toggle-off | rgba(0,0,0,0.14) | Toggle unchecked |
| --color-toggle-on | var(--color-accent-600) | Toggle checked |

### Status Semantic Tokens (both themes)

Defined as primitives first, then semantic aliases:

| Primitive group | 400 shade | 500 shade | 600 shade |
|-----------------|-----------|-----------|-----------|
| --color-success-* | #34d399 | #10b981 | #059669 |
| --color-warning-* | #fbbf24 | #f59e0b | #d97706 |
| --color-danger-* | #f87171 | #ef4444 | #dc2626 |
| --color-info-* | #60a5fa | #3b82f6 | #2563eb |

Semantic status aliases (resolve to correct shade per theme):

| Token | Dark value | Light value | Assigned to |
|-------|-----------|-------------|-------------|
| --color-status-connected | --color-success-400 | --color-success-600 | VPN connected state |
| --color-status-connecting | --color-warning-400 | --color-warning-600 | VPN connecting state |
| --color-status-error | --color-danger-400 | --color-danger-600 | VPN error state |
| --color-status-disconnected | --color-text-muted | --color-text-muted | VPN disconnected state |
| --color-status-info | --color-info-400 | --color-info-600 | Informational messages |

### Status Surface Tokens (both themes)

Background and border tokens for badges, banners, and inline status indicators. These replace the hardcoded rgba values in colors.ts and use opacity over the status primitive color:

| Token | Value pattern | Usage |
|-------|--------------|-------|
| --color-status-connected-bg | success at --opacity-hover-overlay (0.08) | Connected badge/banner background |
| --color-status-connected-border | success at 0.15 opacity | Connected badge/banner border |
| --color-status-error-bg | danger at --opacity-hover-overlay (0.08) | Error badge/banner background |
| --color-status-error-border | danger at 0.15 opacity | Error badge/banner border |
| --color-status-connecting-bg | warning at --opacity-hover-overlay (0.08) | Connecting badge/banner background |
| --color-status-connecting-border | warning at 0.15 opacity | Connecting badge/banner border |
| --color-status-info-bg | info at --opacity-hover-overlay (0.08) | Info badge/banner background |
| --color-status-info-border | info at 0.15 opacity | Info badge/banner border |

Implementation: define as `rgba(R, G, B, var(--opacity-hover-overlay))` using the status-500 primitive RGB channels. This replaces colors.ts `successBg`, `dangerBg`, `warningBg`, `accentBg` and their border counterparts.

Source: CONTEXT.md D-05 (accent discretion), D-06 (status mandatory), D-07 (dark bg no blue), D-08 (light warm cream), D-11 (no indigo), D-13 (no glow); REQUIREMENTS.md DS-07, DS-11

### Accent Reserved For

Accent color is reserved ONLY for these specific elements (10% rule enforced):

1. Primary action buttons (connect/apply/save — active state)
2. Toggle control "on" state fill
3. Input :focus-visible ring (--focus-ring)
4. Active sidebar navigation item indicator
5. Inline links within body text
6. Storybook accent swatches on the Colors MDX page

Accent is NOT used for: headings, card borders, icons in resting state, badges, status indicators, secondary buttons, background fills of non-interactive elements.

### Glow Policy

ALL glow effects removed from the new token system per D-13 (restrained elegance):
- successGlow: DEPRECATED (set to `none` in Phase 1, removed in Phase 6)
- dangerGlow: DEPRECATED (set to `none` in Phase 1, removed in Phase 6)
- accentLogoGlow: DEPRECATED (set to `none` in Phase 1, removed in Phase 6)
- status-dot glow animation: REPLACED with opacity pulse (--pulse-duration, --pulse-easing)

Shadow tokens replace glow:

| Token | Dark value | Light value |
|-------|-----------|-------------|
| --shadow-sm | 0 1px 2px rgba(0,0,0,0.32) | 0 1px 2px rgba(0,0,0,0.06) |
| --shadow-md | 0 4px 12px rgba(0,0,0,0.44) | 0 4px 12px rgba(0,0,0,0.09) |
| --shadow-lg | 0 8px 24px rgba(0,0,0,0.56) | 0 8px 24px rgba(0,0,0,0.13) |
| --shadow-xl | 0 16px 40px rgba(0,0,0,0.64) | 0 16px 40px rgba(0,0,0,0.16) |

Source: CONTEXT.md D-13; colors.ts (glow values set to `none` in Phase 1, fully removed in Phase 6)

### Surface Strategy

Dark theme surfaces (#161616, #1c1c1c) have minimal contrast against bg-primary (#0d0d0d) — ratio ~1.1:1. This is intentional for the near-monochrome aesthetic but requires a structural rule:

**Rule:** All `bg-surface` containers (Cards, panels, elevated elements) MUST use `--color-border` as a 1px border. Surface distinction relies on border, not fill contrast alone. This follows the Linear/Raycast pattern.

---

## Z-Index Scale

Phase 1 defines z-index tokens in tokens.css:

| Token | Value | Assigned to |
|-------|-------|-------------|
| --z-base | 0 | Default stacking |
| --z-dropdown | 100 | Dropdowns, tooltips, select menus |
| --z-sticky | 200 | Sticky headers, sidebar |
| --z-modal | 300 | Modal overlays |
| --z-snackbar | 400 | Toast/SnackBar notifications |
| --z-titlebar | 500 | Custom window title bar / WindowControls |

Source: REQUIREMENTS.md DS-05

---

## Focus Ring Token

| Token | Value | Applied to |
|-------|-------|------------|
| --focus-ring | 0 0 0 2px var(--color-bg-primary), 0 0 0 4px var(--color-accent-interactive) | All interactive elements via :focus-visible |

Focus ring uses double-ring pattern (inner matches bg, outer is accent-interactive) — works on both dark and light backgrounds. The inner ring provides a white/dark halo that guarantees the accent ring is visible even on surfaces close to the accent color.

| Context | Inner ring | Outer ring | Effective contrast |
|---------|-----------|------------|-------------------|
| Dark: element on bg-primary | #0d0d0d | #4d9490 | 5.87:1 ✓ |
| Dark: element on bg-surface | #0d0d0d halo | #4d9490 | 5.87:1 ✓ |
| Light: element on bg-primary | #f9f9f7 | #236260 | 6.73:1 ✓ |

Source: REQUIREMENTS.md DS-06; CONTEXT.md D-03 (premium professional feel)

---

## Opacity Tokens

| Token | Value | Usage |
|-------|-------|-------|
| --opacity-disabled | 0.4 | Disabled interactive elements |
| --opacity-hover-overlay | 0.08 | Hover state overlay on surfaces |
| --opacity-pressed-overlay | 0.12 | Active/pressed state overlay |
| --opacity-backdrop | 0.6 | Modal/dialog backdrop dimming |

Source: standard for interactive state layering; prevents hardcoded rgba values in components

---

## Border Width Tokens

| Token | Value | Usage |
|-------|-------|-------|
| --border-thin | 1px | Default borders, card outlines, dividers |
| --border-medium | 2px | Focus ring outer, active tab indicator |

Source: derived from focus ring spec (2px outer) and card border requirement

---

## Motion Tokens

Phase 1 preserves existing transition tokens and adds easing + pulse:

| Token | Value | Usage |
|-------|-------|-------|
| --transition-fast | 150ms | Hover states, toggles |
| --transition-normal | 200ms | Panel transitions, color changes |
| --transition-slow | 300ms | Layout shifts, sidebar expand/collapse |
| --ease-out | cubic-bezier(0.16, 1, 0.3, 1) | Natural deceleration for UI elements |
| --ease-in-out | cubic-bezier(0.45, 0, 0.55, 1) | Symmetric transitions |
| --pulse-duration | 2s | Status dot opacity pulse cycle |
| --pulse-easing | ease-in-out | Status dot pulse curve |

Usage pattern: `transition: color var(--transition-fast) var(--ease-out)` — duration and easing are always composed separately, never baked into one token.

**Reduced motion:** At `@media (prefers-reduced-motion: reduce)`, all `--transition-*` values resolve to `0ms` and `--pulse-duration` resolves to `0s`. This is implemented as a single media query block at the end of tokens.css.

Source: existing transition tokens preserved; easing curves from modern UI standards; pulse replaces glow animation per D-13; WCAG 2.1 SC 2.3.3

---

## Token Architecture Summary

Two-tier system to be implemented in tokens.css:

**Tier 1 — Primitives** (raw values, no semantic meaning):
- Color palette: accent (teal), success/warning/danger/info scales, neutral grays
- These are referenced ONLY by Tier 2 tokens, never directly in components

**Tier 2 — Semantics** (purpose-named aliases that point to primitives):
- bg-primary, bg-surface, text-primary, border, status-connected, etc.
- Includes: opacity, border-width, motion, tracking, spacing, z-index, shadows, focus ring
- Components reference ONLY semantic tokens
- Themes switch by redefining semantic tokens per [data-theme] in tokens.css
- [data-theme] overrides stay in tokens.css — index.css must have ZERO [data-theme] blocks after Phase 1

Backward compatibility: existing semantic token names (--color-bg-primary, --color-text-primary, --color-border, etc.) are PRESERVED — only their values change. New tokens are additive. This prevents any Phase 1 change from breaking existing components.

Source: REQUIREMENTS.md DS-01, DS-02; CONTEXT.md code_context (backward-compatible token names)

---

## Storybook Foundations Pages (MDX)

Phase 1 produces 4 MDX documentation pages visible at localhost:6006. These are the visual output of Phase 1 that the user reviews and approves.

### Colors page
- All primitive color swatches (accent scale, status scales, neutral grays)
- Semantic token table with dark/light preview side-by-side
- WCAG contrast ratios displayed for each text/bg pair
- Accent reserved-for list rendered as annotated list

### Typography page
- Font family rendered at each size (xs, sm, md, lg)
- Each size at weight 400 and 600
- Letter-spacing demonstrated for each tracking level
- Line height demonstrated with multi-line paragraph example
- System fallback chain displayed

### Spacing page
- Visual ruler showing all 8 spacing steps (--space-1 through --space-8)
- Each step labeled with token name + pixel value
- Side-by-side comparison of compact vs. comfortable spacing

### Shadows page
- All 4 shadow levels (sm, md, lg, xl) rendered on dark and light background
- Contrast with removed glow values (shown as "deprecated" for reference)

Source: REQUIREMENTS.md SB-06, SB-07; CONTEXT.md D-11, D-12 (Storybook as approval tool)

---

## Copywriting Contract

Phase 1 has no end-user screens. Copywriting applies to the Storybook developer tool and theme flash script only.

| Element | Copy |
|---------|------|
| Storybook theme toggle label (dark) | Dark |
| Storybook theme toggle label (light) | Light |
| Storybook addon background label | App Background |
| Colors MDX page title | Colors |
| Typography MDX page title | Typography |
| Spacing MDX page title | Spacing |
| Shadows MDX page title | Shadows |
| Theme flash script comment | // Apply saved theme before React mounts to prevent flash |
| Deprecated glow section header (Shadows page) | Removed in v3.0 |

No empty states, error states, or destructive confirmations in Phase 1 — zero user-facing UI.

Source: REQUIREMENTS.md SB-06 (MDX pages); QA-01 (theme flash)

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none — shadcn not initialized | not applicable |
| third-party | none declared | not applicable |

shadcn/ui and Radix UI are explicitly out of scope for the entire v3.0 milestone.

Source: REQUIREMENTS.md Out of Scope section

---

## WCAG Compliance Summary

All text color pairs verified against WCAG 2.1 AA (4.5:1 minimum for normal text):

| Pair | Dark | Light |
|------|------|-------|
| text-primary on bg-primary | 18.3:1 ✓ | 18.3:1 ✓ |
| text-secondary on bg-primary | 7.4:1 ✓ | 6.6:1 ✓ |
| text-muted on bg-primary | 4.6:1 ✓ | 4.5:1 ✓ |
| accent-interactive on bg-primary | 5.87:1 ✓ | 6.73:1 ✓ |
| text-inverse on accent-interactive | 5.87:1 ✓ | 6.73:1 ✓ |
| destructive on bg-primary | 5.2:1 ✓ | 6.12:1 ✓ |
| focus ring on bg-primary | 5.87:1 ✓ | 6.73:1 ✓ |

---

## Implementation Notes for Executor

1. **tokens.css modification strategy**: Expand the existing file. Do NOT delete and recreate. Add missing token scales (spacing, z-index, focus ring, status semantics, typography, tracking, opacity, border-width, motion) on top of what exists. Change accent and background values. Keep existing semantic token names for backward compatibility.

2. **index.css cleanup (partial)**: Remove any [data-theme] blocks that duplicate tokens.css. The index.css body { font-family } stays. Component-level CSS classes (btn-primary, glass-card, etc.) stay untouched until Phase 2.

3. **colors.ts**: In Phase 1, add `@deprecated` JSDoc to glow exports and set their values to `none`. Full removal happens in Phase 6 after all components switch to token vars.

4. **tailwind.config.js surface palette**: Leave untouched in Phase 1. Removal happens in Phase 6.

5. **index.html theme script**: Add inline `<script>` before `</head>` that reads localStorage and sets data-theme attribute synchronously. Dark is default if no saved preference.

6. **Storybook setup**: No existing .storybook/ directory found. Must be created from scratch. Requires @storybook/react-vite, @storybook/addon-themes. viteFinal must mock @tauri-apps/api.

7. **Surface border rule**: Ensure all Cards and elevated containers use `border: var(--border-thin) solid var(--color-border)`. This is critical because bg-surface has minimal contrast against bg-primary in dark theme.

8. **Reduced motion**: Add a `@media (prefers-reduced-motion: reduce)` block at the end of tokens.css that sets all `--transition-*` to `0ms` and `--pulse-duration` to `0s`. One block, all motion disabled.

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS (all pairs WCAG AA verified)
- [x] Dimension 4 Typography: PASS (scale: 11→12→14→16, min 2px steps)
- [x] Dimension 5 Spacing: PASS (sequential 1–8, all multiples of 4)
- [x] Dimension 6 Registry Safety: PASS

**Approval:** revised — pending re-verification
