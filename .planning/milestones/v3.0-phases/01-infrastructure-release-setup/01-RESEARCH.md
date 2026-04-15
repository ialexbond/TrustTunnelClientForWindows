# Phase 1: Foundation — Research

**Researched:** 2026-04-13
**Domain:** CSS Design Token Architecture + Storybook 10 (Vite + React)
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Absolutely new design approach — NOT an evolution of v2. New principles, new concept, new colors
- **D-02:** Mood: restrained elegance. Near-monochrome system. No bright colors, muted tones, high contrast
- **D-03:** Reference style: Linear, Raycast, Apple System Prefs — premium professional tool feel
- **D-04:** Anti-pattern: must NOT look AI-generated, must NOT repeat v2 indigo identity
- **D-05:** Accent color — Claude's discretion. Must NOT be indigo. Must feel professional and pleasant on neutral background
- **D-06:** Status colors mandatory: success (green), error (red), warning (amber), info (blue)
- **D-07:** Dark theme: neutral deep gray / near-black. NO blue undertone (current #0a0a0f changes). High contrast
- **D-08:** Light theme: warm cream (~#fafaf8 area). Readable on fast theme switch
- **D-09:** Both themes feel like one cohesive system with strong contrast between each other
- **D-10:** Spacing/typography/shadow granularity — Claude's discretion, sized for 32 existing components
- **D-11:** Full MDX documentation pages: Colors, Typography, Spacing, Shadows — with visual token previews
- **D-12:** Storybook is the approval tool — Phase 1 sets up the infrastructure for this workflow
- **D-13:** Minimal effects — remove all glow (successGlow, dangerGlow, accentLogoGlow). Shadows only
- **Accent chosen:** slate-teal (#4d9490 dark / #236260 light) per UI-SPEC
- **All color values:** Fully specified in 01-UI-SPEC.md — executor must use those exact hex values

### Claude's Discretion

- Token scale granularity (spacing steps, typography sizes, shadow levels) — pick what fits 32 components (already specified in UI-SPEC)
- Specific accent color choice — already chosen in UI-SPEC (slate-teal)
- Storybook MDX page format and depth — practical for solo developer

### Deferred Ideas (OUT OF SCOPE)

- All component rendering in Storybook (Phase 2: primitives, Phase 3: screens)
- "Настройки VPN" panel design (Phase 4)
- colors.ts full deletion (Phase 6)
- surface.* Tailwind palette removal (Phase 6)
- index.css !important cleanup (Phase 6)
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DS-01 | Two-tier token architecture: primitives + semantics in tokens.css | Architecture Patterns §1 — two-tier CSS var structure |
| DS-02 | All light/dark themes in tokens.css — zero [data-theme] in index.css | Architecture Patterns §2 — [data-theme] consolidation |
| DS-03 | Typography scale in tokens (--font-size-xs through --font-size-lg, --font-weight-*) | Code Examples §1 |
| DS-04 | Spacing scale in tokens (--space-1 through --space-8, 4px base) | Code Examples §1 |
| DS-05 | Z-index scale in tokens (--z-dropdown through --z-titlebar) | Code Examples §1 |
| DS-06 | Focus ring token (--focus-ring) for :focus-visible on all interactive elements | Code Examples §1 |
| DS-07 | Status semantic tokens (--color-status-connected, --color-status-error, etc.) | Code Examples §1 |
| DS-08 | Glow/shadow tokens replace hardcoded RGBA from colors.ts | Common Pitfalls §2; Code Examples §2 |
| DS-11 | New accent colors for dark and light themes | UI-SPEC (exact values locked) |
| SB-01 | Storybook launches and renders components with full CSS | Standard Stack §Storybook |
| SB-02 | Tauri API mocks via viteFinal resolve aliases | Architecture Patterns §3 (Tauri mock strategy) |
| SB-03 | Theme toggle in toolbar (dark/light) via @storybook/addon-themes | Code Examples §3 |
| SB-06 | MDX Foundations pages: Colors, Typography, Spacing, Shadows | Code Examples §4 |
| SB-07 | Storybook organized by hierarchy: Foundations → Primitives → Patterns | Architecture Patterns §4 |
| SB-08 | HMR works in Storybook (override inherited vite.config.ts hmr:false) | Common Pitfalls §1 |
| SB-09 | Scaffold stories removed, replaced with real | Architecture Patterns §4 |
| QA-01 | Theme flash fixed — inline script in index.html before React mount | Code Examples §5 |
| QA-03 | All existing 83+ behavioral tests continue passing | Common Pitfalls §3 |
| DOC-01 | memory/v3/design-system/ contains full token documentation | Standard Stack §Documentation |
| DOC-07 | memory/v3/decisions/ records all decisions: what was tried, what worked | Standard Stack §Documentation |
</phase_requirements>

---

## Summary

Phase 1 has two distinct deliverables: (1) an expanded tokens.css with a full two-tier design token architecture, and (2) a Storybook 10 installation configured to operate in the Tauri 2 desktop app context. Both are infrastructure — zero component code changes occur.

The token work is primarily additive: the existing tokens.css structure (CSS custom properties, [data-theme] selectors) is the right foundation. The file needs expansion with new accent palette (slate-teal), plus all missing token scales (spacing, z-index, typography, focus ring, status semantics, opacity, border-width, motion). Existing semantic token names are preserved for backward compatibility. The [data-theme] blocks that currently live in index.css must be consolidated into tokens.css.

The Storybook work is greenfield — no .storybook/ directory exists. The critical technical challenge is that Storybook's Vite environment cannot execute Tauri API calls (no native Tauri binary in Storybook). This is solved via viteFinal resolve aliases that redirect all @tauri-apps/* imports to static mock modules. A secondary challenge is overriding the vite.config.ts HMR:false setting (disabled globally to prevent VPN-disrupted reloads) — viteFinal must explicitly re-enable HMR for the Storybook dev server.

**Primary recommendation:** Install Storybook 10 via `npx storybook@latest init` (auto-detects Vite), add @storybook/addon-themes, configure viteFinal with Tauri mocks and HMR override, then expand tokens.css. Write the four Foundations MDX pages last — they document the tokens visually.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| storybook | 10.3.5 | CLI and core orchestration | Latest stable; Storybook 10 ships with Vite builder stable [VERIFIED: npm registry] |
| @storybook/react-vite | 10.3.5 | React + Vite framework for Storybook | Official framework integration, auto-detects Vite [VERIFIED: npm registry] |
| @storybook/addon-themes | 10.3.5 | Theme toggle (withThemeByDataAttribute) | Official addon for data-theme switching [VERIFIED: npm registry] |
| @storybook/blocks | 8.6.14 | MDX doc block components (Meta, ColorPalette, etc.) | Separate versioning from main packages; ships with addon-docs [VERIFIED: npm registry] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| CSS custom properties | native | Token transport mechanism | Already in use — this is the project's approach |
| [data-theme] attribute | native | Theme switching selector | Already established pattern in tokens.css |
| localStorage | native | Theme preference persistence | Used for flash prevention script |

### Alternatives Considered (Already Rejected in REQUIREMENTS.md)

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| CSS custom properties | Style Dictionary | Overkill for solo dev — direct CSS vars sufficient |
| CSS custom properties | CSS-in-JS | Runtime overhead, conflicts with Tailwind |
| Manual Storybook config | Chromatic | Paid, more than needed |
| @storybook/addon-themes | storybook-dark-mode | Third-party, less reliable, uses class not data-attr |

**Installation (run from gui-app/):**
```bash
npx storybook@latest init
npm install --save-dev @storybook/addon-themes
```

**Version verification:** [VERIFIED: npm registry 2026-04-13]
- storybook@latest = 10.3.5
- @storybook/react-vite@latest = 10.3.5
- @storybook/addon-themes@latest = 10.3.5
- @storybook/blocks@latest = 8.6.14 (separate semver track)

---

## Architecture Patterns

### Recommended Project Structure

```
gui-app/
├── .storybook/
│   ├── main.ts              # Framework, stories glob, addons, viteFinal
│   ├── preview.ts           # Global decorators (withThemeByDataAttribute), CSS imports
│   └── tauri-mocks/
│       ├── api-core.ts      # mock for @tauri-apps/api/core
│       ├── api-event.ts     # mock for @tauri-apps/api/event
│       ├── api-app.ts       # mock for @tauri-apps/api/app
│       ├── api-window.ts    # mock for @tauri-apps/api/window
│       ├── plugin-dialog.ts # mock for @tauri-apps/plugin-dialog
│       └── plugin-shell.ts  # mock for @tauri-apps/plugin-shell
├── src/
│   ├── shared/
│   │   └── styles/
│   │       └── tokens.css   # EXPANDED — two-tier tokens, all scales
│   ├── stories/             # DELETED — scaffold stories removed (SB-09)
│   └── docs/                # MDX Foundations pages (or co-located in .storybook/)
└── index.html               # Add inline theme script before </head>
```

### Pattern 1: Two-Tier CSS Token Architecture

**What:** Primitives define raw values (color stops, numeric values). Semantics define purpose-named aliases pointing to primitives. Theme switching redefines only semantic tokens per [data-theme].

**When to use:** Always. Components reference only semantic tokens. Primitives are never used directly in components.

```css
/* Source: REQUIREMENTS.md DS-01; UI-SPEC Token Architecture Summary */

/* ── TIER 1: PRIMITIVES (raw values, global :root) ── */
:root {
  /* Accent scale — slate-teal */
  --color-accent-400: #4d9490;
  --color-accent-500: #2d7a76;
  --color-accent-600: #236260;
  /* ... full 50-900 scale per UI-SPEC */

  /* Status primitives */
  --color-success-400: #34d399;
  --color-success-500: #10b981;
  --color-success-600: #059669;
  /* warning, danger, info scales ... */

  /* Spacing scale — 4px base */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 32px;
  --space-8: 40px;

  /* Typography */
  --font-size-xs: 11px;
  --font-size-sm: 12px;
  --font-size-md: 14px;
  --font-size-lg: 16px;
  --font-weight-normal: 400;
  --font-weight-semibold: 600;
  --tracking-tight: -0.01em;
  --tracking-normal: 0;
  --tracking-wide: 0.02em;

  /* Z-index scale */
  --z-base: 0;
  --z-dropdown: 100;
  --z-sticky: 200;
  --z-modal: 300;
  --z-snackbar: 400;
  --z-titlebar: 500;

  /* Opacity */
  --opacity-disabled: 0.4;
  --opacity-hover-overlay: 0.08;
  --opacity-pressed-overlay: 0.12;
  --opacity-backdrop: 0.6;

  /* Border widths */
  --border-thin: 1px;
  --border-medium: 2px;

  /* Motion */
  --transition-fast: 150ms;
  --transition-normal: 200ms;
  --transition-slow: 300ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out: cubic-bezier(0.45, 0, 0.55, 1);
  --pulse-duration: 2s;
  --pulse-easing: ease-in-out;

  /* Radius (existing — preserved) */
  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
  --radius-full: 9999px;

  /* Sidebar (existing — preserved) */
  --sidebar-width-collapsed: 56px;
  --sidebar-width-expanded: 220px;
}

/* ── TIER 2: SEMANTICS — Dark theme (default) ── */
[data-theme="dark"],
:root {
  /* Backgrounds */
  --color-bg-primary: #0d0d0d;
  --color-bg-secondary: #161616;
  --color-bg-surface: #1c1c1c;
  --color-bg-elevated: #222222;
  --color-bg-hover: #2a2a2a;
  --color-bg-active: #323232;

  /* Text */
  --color-text-primary: #f2f2f2;
  --color-text-secondary: #9a9a9a;
  --color-text-muted: #6e6e6e;
  --color-text-inverse: #0d0d0d;

  /* Borders */
  --color-border: rgba(255, 255, 255, 0.08);
  --color-border-hover: rgba(255, 255, 255, 0.14);
  --color-border-active: rgba(255, 255, 255, 0.22);

  /* Inputs */
  --color-input-bg: rgba(255, 255, 255, 0.05);
  --color-input-border: rgba(255, 255, 255, 0.12);
  --color-input-focus: var(--color-accent-400);

  /* Toggles */
  --color-toggle-off: rgba(255, 255, 255, 0.12);
  --color-toggle-on: var(--color-accent-400);

  /* Accent semantic aliases */
  --color-accent-interactive: var(--color-accent-400);
  --color-accent-hover: var(--color-accent-300);
  --color-accent-active: var(--color-accent-500);

  /* Destructive */
  --color-destructive: #e05545;

  /* Status text */
  --color-status-connected: var(--color-success-400);
  --color-status-connecting: var(--color-warning-400);
  --color-status-error: var(--color-danger-400);
  --color-status-disconnected: var(--color-text-muted);
  --color-status-info: var(--color-info-400);

  /* Status surfaces */
  --color-status-connected-bg: rgba(16, 185, 129, 0.08);
  --color-status-connected-border: rgba(16, 185, 129, 0.15);
  --color-status-error-bg: rgba(239, 68, 68, 0.08);
  --color-status-error-border: rgba(239, 68, 68, 0.15);
  --color-status-connecting-bg: rgba(245, 158, 11, 0.08);
  --color-status-connecting-border: rgba(245, 158, 11, 0.15);
  --color-status-info-bg: rgba(59, 130, 246, 0.08);
  --color-status-info-border: rgba(59, 130, 246, 0.15);

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.32);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.44);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.56);
  --shadow-xl: 0 16px 40px rgba(0, 0, 0, 0.64);

  /* Focus ring */
  --focus-ring: 0 0 0 2px var(--color-bg-primary), 0 0 0 4px var(--color-accent-interactive);
}

/* ── TIER 2: SEMANTICS — Light theme ── */
[data-theme="light"] {
  /* Backgrounds */
  --color-bg-primary: #f9f9f7;
  --color-bg-secondary: #ffffff;
  --color-bg-surface: #f0f0ed;
  --color-bg-elevated: #e8e8e5;
  --color-bg-hover: #e2e2de;
  --color-bg-active: #d8d8d4;

  /* Text */
  --color-text-primary: #161616;
  --color-text-secondary: #5a5a5a;
  --color-text-muted: #767676;
  --color-text-inverse: #f9f9f7;

  /* Borders */
  --color-border: rgba(0, 0, 0, 0.09);
  --color-border-hover: rgba(0, 0, 0, 0.15);
  --color-border-active: rgba(0, 0, 0, 0.24);

  /* Inputs */
  --color-input-bg: #f4f4f1;
  --color-input-border: #c8c8c4;
  --color-input-focus: var(--color-accent-600);

  /* Toggles */
  --color-toggle-off: rgba(0, 0, 0, 0.14);
  --color-toggle-on: var(--color-accent-600);

  /* Accent semantic aliases */
  --color-accent-interactive: var(--color-accent-600);
  --color-accent-hover: var(--color-accent-700);
  --color-accent-active: var(--color-accent-800);

  /* Destructive */
  --color-destructive: #b03020;

  /* Status text */
  --color-status-connected: var(--color-success-600);
  --color-status-connecting: var(--color-warning-600);
  --color-status-error: var(--color-danger-600);
  --color-status-disconnected: var(--color-text-muted);
  --color-status-info: var(--color-info-600);

  /* Status surfaces */
  --color-status-connected-bg: rgba(5, 150, 105, 0.08);
  --color-status-connected-border: rgba(5, 150, 105, 0.15);
  --color-status-error-bg: rgba(220, 38, 38, 0.08);
  --color-status-error-border: rgba(220, 38, 38, 0.15);
  --color-status-connecting-bg: rgba(217, 119, 6, 0.08);
  --color-status-connecting-border: rgba(217, 119, 6, 0.15);
  --color-status-info-bg: rgba(37, 99, 235, 0.08);
  --color-status-info-border: rgba(37, 99, 235, 0.15);

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.06);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.09);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.13);
  --shadow-xl: 0 16px 40px rgba(0, 0, 0, 0.16);

  /* Focus ring */
  --focus-ring: 0 0 0 2px var(--color-bg-primary), 0 0 0 4px var(--color-accent-interactive);
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
  :root {
    --transition-fast: 0ms;
    --transition-normal: 0ms;
    --transition-slow: 0ms;
    --pulse-duration: 0s;
  }
}
```

### Pattern 2: [data-theme] Consolidation from index.css

**What:** The 38 !important overrides in index.css exist because Tailwind utility classes (text-gray-100, bg-white/5, etc.) can't respond to tokens. Phase 1 moves all `[data-theme]` blocks from index.css to tokens.css. The index.css `[data-theme]` blocks are deleted.

**When to use:** Phase 1 only — this is the consolidation step. Phase 6 eliminates the underlying Tailwind hardcodes.

**Rule:** After Phase 1, index.css must contain zero `[data-theme]` selectors. All theme-responsive behavior is driven purely by token values in tokens.css.

**Identified blocks to move** (from index.css line audit):
- Lines 131-244: All `[data-theme="light"]` and `[data-theme="dark"]` overrides for Tailwind color classes

### Pattern 3: Storybook Tauri Mock Strategy

**What:** viteFinal in .storybook/main.ts creates Vite module aliases that redirect @tauri-apps/* imports to static TypeScript mock files in .storybook/tauri-mocks/.

**Why this approach:** The 6 Tauri package paths actually imported in non-test source files are a known, finite set (verified by codebase grep). Mocking at the module resolution level (not the story level) means any component rendered in Storybook — including future ones — automatically gets mocked Tauri APIs with zero story-level configuration.

**The 6 paths to mock** (verified from codebase):
- `@tauri-apps/api/core` — invoke
- `@tauri-apps/api/event` — listen, emit
- `@tauri-apps/api/app` — getVersion
- `@tauri-apps/api/window` — getCurrentWindow, Window
- `@tauri-apps/plugin-dialog` — open
- `@tauri-apps/plugin-shell` — open

**Note on Storybook 10 automocking:** Storybook 10 introduced `sb.mock()` for automocking. However, for external native packages like @tauri-apps/api that cannot execute in a browser environment, viteFinal resolve aliases remain the correct approach — they prevent the import from even attempting to load the native module. [CITED: storybook.js.org/docs/writing-stories/mocking-data-and-modules/mocking-modules]

```typescript
// Source: storybook.js.org/docs/api/main-config/main-config-vite-final
// .storybook/main.ts
import type { StorybookConfig } from '@storybook/react-vite';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: [
    '@storybook/addon-essentials',
    '@storybook/addon-themes',
  ],
  async viteFinal(config) {
    const { mergeConfig } = await import('vite');
    return mergeConfig(config, {
      server: {
        // Re-enable HMR for Storybook — vite.config.ts disables it globally
        // to prevent VPN-disrupted reloads, but Storybook needs HMR for DX
        hmr: { host: 'localhost', port: 6006, protocol: 'ws' },
      },
      resolve: {
        alias: {
          '@tauri-apps/api/core': path.resolve(__dirname, './tauri-mocks/api-core.ts'),
          '@tauri-apps/api/event': path.resolve(__dirname, './tauri-mocks/api-event.ts'),
          '@tauri-apps/api/app': path.resolve(__dirname, './tauri-mocks/api-app.ts'),
          '@tauri-apps/api/window': path.resolve(__dirname, './tauri-mocks/api-window.ts'),
          '@tauri-apps/plugin-dialog': path.resolve(__dirname, './tauri-mocks/plugin-dialog.ts'),
          '@tauri-apps/plugin-shell': path.resolve(__dirname, './tauri-mocks/plugin-shell.ts'),
        },
      },
    });
  },
};

export default config;
```

**Windows path note:** Use `fileURLToPath(import.meta.url)` to derive `__dirname` in ESM — cross-platform, works on Windows. Do NOT use `__dirname` directly (not available in ESM) or `import.meta.resolve()` (inconsistent on Windows Git Bash). [CITED: Search verification, multiple sources]

### Pattern 4: Storybook Organization (SB-07, SB-09)

**Sidebar hierarchy (via story titles):**
```
Foundations/
  ├── Colors        (MDX)
  ├── Typography    (MDX)
  ├── Spacing       (MDX)
  └── Shadows       (MDX)
Primitives/         (Phase 2 fills this)
Patterns/           (Phase 2+ fills this)
```

**Scaffold stories removal:** The `npx storybook@latest init` command generates example stories in `src/stories/`. Delete this entire directory after init. Do NOT commit scaffold stories.

**Stories glob pattern:** Set `stories` in main.ts to only include real story files:
```typescript
stories: [
  '../src/**/*.mdx',
  '../src/**/*.stories.@(js|jsx|ts|tsx)'
]
```

### Anti-Patterns to Avoid

- **Using Tailwind classes in stories instead of token vars:** MDX pages must demonstrate CSS vars directly, not Tailwind utilities — Tailwind utilities are the problem this phase is solving
- **Adding [data-theme] to index.css:** All theme-responsive values belong in tokens.css after Phase 1
- **Using @tauri-apps mocks only per-story:** Module-level aliases in viteFinal prevent crashes globally; per-story mocking is a fragile fallback
- **Re-using old transition shorthands:** The existing `--transition-fast: 150ms ease` must be split into separate duration and easing tokens (`var(--transition-fast) var(--ease-out)` composition pattern)
- **Deleting tokens.css and recreating:** Must expand in-place. Existing components rely on current token names — names are preserved, values change

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Theme toggle in Storybook | Custom toolbar button + React context | @storybook/addon-themes withThemeByDataAttribute | Handles iframe/canvas attribute injection, syncs with Storybook toolbar state |
| Module mocking for Tauri | Per-story mock setup files | viteFinal resolve.alias | Aliases work at build time, prevent module load — no runtime crash possible |
| WCAG contrast checking | Manual calculation | Values already verified in UI-SPEC | All pairs verified in 01-UI-SPEC.md — do not recalculate |
| Token documentation | Inline HTML tables | @storybook/blocks ColorPalette, Typeset | Official doc blocks render token previews interactively |

**Key insight:** The test suite already has a complete Tauri mock at `src/test/tauri-mock.ts` (6 mock targets, correct mock values). The Storybook tauri-mocks/ files should mirror this structure — same mock shapes, adapted from `vi.fn()` to plain ESM exports.

---

## Common Pitfalls

### Pitfall 1: HMR Blocked by Inherited Vite Config

**What goes wrong:** Storybook's `@storybook/react-vite` loads `vite.config.ts` as a base. That file has `hmr: false` and `watch: null`. Storybook inherits these settings and HMR stops working — file saves don't update the browser.

**Why it happens:** Storybook merges its Vite config with the project's vite.config.ts. The `hmr: false` from vite.config.ts is intentional for the Tauri app (VPN changes kill network connections), but it breaks the Storybook dev experience.

**How to avoid:** In viteFinal, use `mergeConfig` with an explicit `server.hmr` override. mergeConfig deep-merges, so the override wins. [CITED: storybook.js.org/docs/builders/vite]

**Warning signs:** Editing a story file, MDX page, or tokens.css does not update Storybook in the browser.

### Pitfall 2: colors.ts RGBA Values — Glow to `none`, Not Deleted

**What goes wrong:** colors.ts exports glow values used by existing components. Deleting or changing the property names breaks TypeScript consumers. Setting them to empty string fails the type `string` contract differently than expected.

**Why it happens:** `successGlow`, `dangerGlow`, `accentLogoGlow` are referenced in components (verified in CONTEXT.md). Phase 6 removes colors.ts entirely. Phase 1 only deprecates.

**How to avoid:** In Phase 1, add `@deprecated` JSDoc and set glow values to `'none'` (valid CSS box-shadow value for "no shadow"). Status background values (`successBg`, `dangerBg`, etc.) can point to the new token vars via `var(--color-status-connected-bg)` — but this requires inline style usage, not tokens. Actually: colors.ts values stay as-is in Phase 1 except glows → `'none'`. The status surface tokens are new additions in tokens.css that components will migrate to in Phase 2.

**Warning signs:** TypeScript errors in components that import from colors.ts; visual regression on connected/error status badges.

### Pitfall 3: Breaking Existing Tests (QA-03)

**What goes wrong:** The 83 vitest tests mock Tauri in `src/test/tauri-mock.ts` and import tokens.css (Vite CSS processing). Changing token variable names breaks any test that asserts on CSS classes or computed styles. Changing component JSX structure (even accidentally) breaks snapshot tests.

**Why it happens:** Phase 1 is "zero component changes" but the executor might accidentally touch component files while exploring the codebase.

**How to avoid:** Phase 1 touches exactly these files: `tokens.css` (expand), `index.css` (remove [data-theme] blocks), `index.html` (add script), `colors.ts` (add @deprecated, set glows to 'none'), `gui-app/package.json` (add Storybook deps), `gui-app/.storybook/` (create from scratch). Zero changes to `src/shared/ui/**`, `src/components/**`, or any `.tsx` component file.

**Warning signs:** Any TypeScript error in a component file signals scope creep.

### Pitfall 4: Storybook Needs index.css AND tokens.css Both Imported

**What goes wrong:** Storybook renders components using only what's imported in preview.ts. If only tokens.css is imported, components miss the `@tailwind` directives, body font settings, and utility class definitions from index.css.

**Why it happens:** Tailwind's PostCSS plugin processes @tailwind directives in index.css. If index.css is not imported in preview.ts, Tailwind utilities (used throughout existing components) produce no CSS.

**How to avoid:** In `.storybook/preview.ts`, import both:
```typescript
import '../src/index.css'; // includes @tailwind, body, .glass-card, etc.
```
Since index.css already imports tokens.css (via `@import` or cascade), or they are both included in the Vite entrypoint chain, this covers both. Verify the import chain — tokens.css may need an explicit import in preview.ts too if it's not referenced by index.css.

**Warning signs:** Components render without colors (tokens missing) or without layout (Tailwind missing).

### Pitfall 5: Storybook Preview Uses Wrong data-theme Target Element

**What goes wrong:** withThemeByDataAttribute sets data-theme on the Storybook canvas iframe's `<html>` element by default. But tokens.css defines `[data-theme="dark"]` selectors. If the decorator targets a different element, tokens don't apply.

**Why it happens:** Storybook wraps stories in an iframe. The [data-theme] attribute must be on the `<html>` or `<body>` of that iframe, not on a wrapper div.

**How to avoid:** Use `withThemeByDataAttribute` which targets the `<html>` element of the preview iframe by default — this matches the `[data-theme]` CSS selector pattern used in tokens.css. [CITED: storybook.js.org/docs/essentials/themes]

---

## Code Examples

### 1. Reduced-Motion Block (end of tokens.css)

```css
/* Source: UI-SPEC Motion Tokens; WCAG 2.1 SC 2.3.3 */
@media (prefers-reduced-motion: reduce) {
  :root {
    --transition-fast: 0ms;
    --transition-normal: 0ms;
    --transition-slow: 0ms;
    --pulse-duration: 0s;
  }
}
```

### 2. colors.ts Deprecation Pattern (Phase 1 only — glow to `none`)

```typescript
// Source: CONTEXT.md D-13; UI-SPEC Glow Policy
export const colors = {
  successBg: "rgba(16, 185, 129, 0.1)",   // unchanged — migration in Phase 2
  successBgSubtle: "rgba(16, 185, 129, 0.06)",
  successBorder: "rgba(16, 185, 129, 0.15)",
  /** @deprecated Phase 1: set to none per D-13 (restrained elegance). Removed in Phase 6. */
  successGlow: "none",

  warningBg: "rgba(245, 158, 11, 0.1)",
  warningBorder: "rgba(245, 158, 11, 0.15)",

  dangerBg: "rgba(239, 68, 68, 0.08)",
  dangerBorder: "rgba(239, 68, 68, 0.15)",
  /** @deprecated Phase 1: set to none per D-13. Removed in Phase 6. */
  dangerGlow: "none",

  accentBg: "rgba(99, 102, 241, 0.1)",     // unchanged — migration in Phase 2
  accentBgSubtle: "rgba(99, 102, 241, 0.08)",
  accentBorder: "rgba(99, 102, 241, 0.2)",
  /** @deprecated Phase 1: set to none per D-13. Removed in Phase 6. */
  accentLogoGlow: "none",

  dropdownShadow: "0 8px 24px rgba(0,0,0,0.24)",
} as const;
```

### 3. preview.ts — Theme Toggle Setup

```typescript
// Source: storybook.js.org/docs/essentials/themes
// .storybook/preview.ts
import type { Preview, Renderer } from '@storybook/react-vite';
import { withThemeByDataAttribute } from '@storybook/addon-themes';
import '../src/index.css';

const preview: Preview = {
  decorators: [
    withThemeByDataAttribute<Renderer>({
      themes: {
        dark: 'dark',
        light: 'light',
      },
      defaultTheme: 'dark',
      attributeName: 'data-theme',
    }),
  ],
  parameters: {
    backgrounds: { disable: true }, // Disable bg addon — theme handles it
    layout: 'centered',
  },
};

export default preview;
```

### 4. Standalone MDX Foundations Page

```mdx
{/* Source: storybook.js.org/docs/writing-docs/mdx */}
{/* .storybook/docs/Colors.mdx or src/docs/Colors.mdx */}
import { Meta, ColorPalette, ColorItem } from '@storybook/blocks';

<Meta title="Foundations/Colors" />

# Colors

Near-monochrome system. Restrained elegance.

## Accent — Slate-Teal

<ColorPalette>
  <ColorItem
    title="Accent"
    subtitle="Primary interactive color"
    colors={{
      '400 (dark interactive)': '#4d9490',
      '500 (brand midpoint)': '#2d7a76',
      '600 (light interactive)': '#236260',
    }}
  />
</ColorPalette>

## Dark Theme Surfaces

| Token | Value | Usage |
|-------|-------|-------|
| --color-bg-primary | #0d0d0d | Window background |
| --color-bg-surface | #1c1c1c | Cards (always + --color-border) |

...
```

### 5. Theme Flash Prevention Script (index.html)

```html
<!-- Source: dev.to/gaisdav — verified pattern; REQUIREMENTS.md QA-01 -->
<!-- gui-app/index.html, before </head> -->
<script>
  // Apply saved theme before React mounts to prevent flash
  (function() {
    try {
      var saved = localStorage.getItem('data-theme');
      var theme = saved || 'dark'; // dark is default if no preference
      document.documentElement.setAttribute('data-theme', theme);
    } catch (e) {
      // localStorage blocked (private mode) — use dark default
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  })();
</script>
```

**Critical:** The script must be inside an IIFE to avoid polluting the global scope. The localStorage key `'data-theme'` must match whatever key the React theme provider uses to persist the preference — verify in the app's theme toggle logic before setting this key.

### 6. Tauri Mock File Pattern (from existing test mock)

```typescript
// Source: gui-app/src/test/tauri-mock.ts (existing, verified in codebase)
// .storybook/tauri-mocks/api-core.ts
// Plain ESM exports — no vi.fn(), these are Storybook mocks not Vitest mocks

export const invoke = async (_command: string, _args?: unknown): Promise<unknown> => {
  console.warn(`[Storybook] Tauri invoke called: ${_command}`);
  return null;
};
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Storybook with Webpack | @storybook/react-vite | Storybook 7+ | Shares Vite config, faster, viteFinal replaces webpack config |
| `.storybook/config.js` | `.storybook/main.ts` + `preview.ts` | Storybook 6+ | Typed config, better separation of concerns |
| storybook-dark-mode (third party) | @storybook/addon-themes (official) | Storybook 7.6 | withThemeByDataAttribute is the official pattern now |
| `__dirname` in ESM main.ts | `fileURLToPath(import.meta.url)` | Node 12.17+ | ESM has no __dirname; use URL API for cross-platform paths |
| Glow box-shadows on status dots | Opacity pulse animation | v3.0 Phase 1 | Restrained elegance direction, WCAG 2.3.3 compliance |

**Deprecated/outdated in this project:**
- `--color-glass-bg`: Existing token in tokens.css — not in the v3 spec, but don't remove in Phase 1 (backward compat)
- `--transition-fast: 150ms ease`: The `ease` is baked in — Phase 1 splits to separate duration + easing tokens. Old shorthand remains for backward compat until Phase 2 migrates components.
- indigo accent (`--color-accent-500: #6366f1`): Replaced by slate-teal. The primitive vars are overwritten; semantic aliases auto-update.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The localStorage key used by the React theme provider to persist theme choice matches `'data-theme'` | Code Examples §5 | Theme flash script reads wrong key → flash not prevented |
| A2 | `npx storybook@latest init` auto-detects the Vite framework and generates @storybook/react-vite config | Standard Stack | If detection fails, manual framework flag needed: `--type react` |
| A3 | index.css does NOT @import tokens.css — they're loaded separately in Vite | Common Pitfalls §4 | If tokens.css is already @imported by index.css, importing it again in preview.ts causes duplication but not breakage |

---

## Open Questions (RESOLVED)

1. **Theme localStorage key used by existing ThemeProvider**
   - What we know: index.html currently uses `class="dark"` (not data-theme). The app has a theme toggle somewhere.
   - What's unclear: What key does the existing React theme logic write to localStorage? `'theme'`, `'data-theme'`, or something else?
   - Recommendation: Before writing the flash script, grep for `localStorage.setItem` in the src/ to find the exact key. Use that key in the script.
   - **RESOLVED: Key is `tt_theme` (confirmed in gui-app/src/shared/hooks/useTheme.ts line: `localStorage.getItem("tt_theme")`). Flash prevention script in 01-01-PLAN.md Task 2 uses this exact key.**

2. **Whether index.css @imports tokens.css**
   - What we know: Both files exist. Vite's main.tsx likely imports both.
   - What's unclear: If index.css `@import`s tokens.css, then importing only index.css in preview.ts covers both.
   - Recommendation: Check `src/main.tsx` imports and `src/index.css` top matter before configuring preview.ts imports.
   - **RESOLVED: Loaded separately in main.tsx — tokens.css is NOT @imported by index.css. Storybook preview.ts must import both files explicitly (`import '../src/shared/styles/tokens.css'` and `import '../src/index.css'`). Confirmed in 01-02-PLAN.md Task 1 Step 5.**

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Storybook install/run | Yes | v24.13.1 | — |
| npm | Package installation | Yes | 11.6.2 | — |
| Vite | Storybook builder | Yes (^6.0.0 installed) | ^6.0.0 | — |
| React | Storybook renderer | Yes (^19.0.0) | ^19.0.0 | — |

No missing dependencies. Node 24 and npm 11 fully support Storybook 10. [VERIFIED: environment probe]

---

## Validation Architecture

No `workflow.nyquist_validation` found in config.json (file absent) — treating as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.x (not yet installed — closest: vitest@4.1.0 is listed in package.json devDeps) |
| Config file | vite.config.ts (test block inline) |
| Quick run command | `cd gui-app && npx vitest run --reporter=dot` |
| Full suite command | `cd gui-app && npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DS-01 | tokens.css contains two-tier structure | manual | inspect file structure | N/A — CSS file audit |
| DS-02 | index.css has zero [data-theme] blocks | manual | `grep -c "data-theme" src/index.css` → must be 0 | N/A |
| QA-01 | Theme flash prevented | manual | Open app — no flash on load | N/A |
| QA-03 | 83+ tests continue passing | automated | `cd gui-app && npx vitest run` | ✅ existing tests |
| SB-01 | Storybook starts without crash | manual | `cd gui-app && npm run storybook` | N/A |
| SB-02 | Tauri imports don't crash | manual | Open any component story in Storybook | N/A |
| SB-03 | Theme toggle works | manual | Toggle in Storybook toolbar | N/A |
| SB-08 | HMR works | manual | Edit tokens.css — browser updates | N/A |

### Sampling Rate

- **Per task commit:** `grep -c "data-theme" gui-app/src/index.css` + `npm run storybook` smoke test
- **Per wave merge:** `npx vitest run` full suite
- **Phase gate:** Full vitest suite green + Storybook opens + theme toggle works + no flash

### Wave 0 Gaps

- [ ] No new test files needed for Phase 1 — all deliverables are CSS/config/HTML
- [ ] Storybook install adds `storybook` and `build-storybook` scripts to package.json — verify after init

---

## Security Domain

Phase 1 is CSS tokens, Storybook config, and an inline HTML script. No authentication, sessions, data input, cryptography, or network calls. Security domain: not applicable.

The inline script in index.html reads only from localStorage (no external data) and writes only to document.documentElement attributes. No injection risk from this pattern.

---

## Sources

### Primary (HIGH confidence)
- [VERIFIED: npm registry, 2026-04-13] — storybook@latest=10.3.5, @storybook/react-vite@latest=10.3.5, @storybook/addon-themes@latest=10.3.5, @storybook/blocks@latest=8.6.14
- [CITED: storybook.js.org/docs/builders/vite] — viteFinal API, HMR override, mergeConfig pattern
- [CITED: storybook.js.org/docs/essentials/themes] — withThemeByDataAttribute decorator, attributeName config
- [CITED: storybook.js.org/docs/writing-docs/mdx] — standalone MDX page structure, Meta title
- [VERIFIED: codebase grep] — 6 Tauri import paths in non-test source; existing tauri-mock.ts structure
- [CITED: 01-UI-SPEC.md] — All color values, contrast ratios, token scale values
- [CITED: 01-CONTEXT.md] — All locked decisions D-01 through D-13

### Secondary (MEDIUM confidence)
- [CITED: storybook.js.org/docs/writing-stories/mocking-data-and-modules/mocking-modules] — viteFinal aliases for external packages
- [CITED: dev.to/gaisdav] — Theme flash prevention inline script pattern (multiple sources confirm this pattern)
- [CITED: storybook.js.org/docs/get-started/frameworks/react-vite] — Installation via npx storybook@latest init

### Tertiary (LOW confidence)
- None — all key claims verified via official docs or registry

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions verified from npm registry
- Token architecture: HIGH — all values from approved UI-SPEC + existing codebase
- Storybook setup: HIGH — official docs verified, existing test mock structure confirmed
- HMR pitfall: HIGH — documented in vite.config.ts (hmr:false explicitly visible)
- Theme flash script: MEDIUM — pattern widely documented, localStorage key needs verification

**Research date:** 2026-04-13
**Valid until:** 2026-05-13 (Storybook 10 is stable; token values are from locked UI-SPEC)
