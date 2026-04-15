---
phase: 4
slug: application-shell
review_type: re-audit
previous_score: 18/24
audited: 2026-04-15
baseline: 04-UI-SPEC.md
screenshots: not captured (no dev server detected)
---

# Phase 4 — UI Review (Re-Audit)

**Audited:** 2026-04-15
**Baseline:** 04-UI-SPEC.md (approved design contract)
**Screenshots:** not captured (no dev server at localhost:3000 or localhost:5173 — code-only audit)
**Previous score:** 18/24

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 4/4 | All i18n keys resolve correctly; spec copy fully matched |
| 2. Visuals | 3/4 | Focus ring added; tab icons swapped; active indicator is bg-fill not 3px underline |
| 3. Color | 4/4 | No dead CSS, no hardcoded colors; all semantic token vars |
| 4. Typography | 3/4 | Arbitrary px values in TitleBar; app name 12px/medium vs spec 14px/semibold |
| 5. Spacing | 3/4 | Tab bar 56px vs spec 40px; window controls 30x26px vs spec 40x32px |
| 6. Experience Design | 3/4 | Disabled tab gating and arrow-key nav absent; good state coverage otherwise |

**Overall: 20/24** (+2 from previous 18/24)

---

## Top 3 Priority Fixes

1. **Active tab indicator is background fill, not 3px accent underline** — breaks the spec's primary active-state visual contract. The pill fill (`--color-bg-elevated`) is visually heavier than the minimal underline designed to match the Linear/Raycast reference aesthetic. In `TabNavigation.tsx` line 58–61: remove `backgroundColor: active ? "var(--color-bg-elevated)" : undefined`, add `position: relative` to the button, and render an absolute-positioned child at bottom with `height: 3px; width: 60%; background: var(--color-accent-interactive); border-radius: var(--radius-full); left: 50%; transform: translateX(-50%)`. Also set active icon color to `--color-text-primary` instead of `--color-accent-interactive` — the underline should be the accent element, not the icon.

2. **TabNavigation missing `hasConfig` prop and disabled-tab gating** — connection/routing/settings tabs are always fully clickable. UI-SPEC.md State Matrix requires those tabs to render at 40% opacity with `aria-disabled="true"` and blocked clicks when `hasConfig = false`. Without this, a first-run user sees no visual indication that 3 tabs require setup. Add `hasConfig?: boolean` to `TabNavigationProps`, add `requiresConfig: true` to the three entries in `TABS`, and apply `aria-disabled`, `opacity-40 cursor-not-allowed`, click guard when `!hasConfig && tab.requiresConfig`.

3. **TitleBar app name 12px/medium instead of spec 14px/semibold** — `TitleBar.tsx` line 29 uses `text-[12px] font-medium`; spec requires 14px semibold (`--font-size-md`, `--font-weight-semibold`). PRO badge is 9px vs spec 11px. Both use arbitrary Tailwind px classes that bypass the token system. Replace with `style={{ fontSize: "var(--font-size-md)", fontWeight: "var(--font-weight-semibold)" }}` for app name and `style={{ fontSize: "var(--font-size-xs)" }}` for PRO badge.

---

## Detailed Findings

### Pillar 1: Copywriting (4/4)

All copywriting contract items from UI-SPEC.md are met.

Tab labels via i18n (verified in `ru.json` lines 2–15):
- `tabs.controlPanel` → "Панель управления"
- `tabs.connection` → "Подключение"
- `tabs.routing` → "Маршрутизация"
- `tabs.appSettings` → "Настройки"
- `tabs.about` → "О программе"

Note: spec declares i18n key `tabs.settings` for the settings tab (UI-SPEC.md line 243), implementation uses `tabs.appSettings`. Both resolve to "Настройки" in Russian — no user-visible copy error. Key-name mismatch is informational only.

ServerSidebar copy (`ru.json` lines 1029–1034, used in `ServerSidebar.tsx` lines 38, 81, 99–100, 109):
- "Серверы" / "Добавить сервер" / "Нет серверов" / "Настройте подключение в «Панель управления»" — all match spec.

WindowControls `aria-label`: "Minimize", "Maximize", "Close" at lines 26, 44, 62.
Disconnect `aria-label`: `"Отключить {server name}"` at `ServerSidebar.tsx` line 81 — matches spec.
No generic "Submit / Click Here / OK / Cancel" patterns found in any Phase 4 layout component.

---

### Pillar 2: Visuals (3/4)

**Improvements confirmed since previous audit:**
- Focus ring: `TabNavigation.tsx` line 52 — `focus-visible:ring-2 focus-visible:ring-[var(--color-accent-interactive)] focus-visible:ring-offset-1`. Satisfies accessibility contract.
- Icons: connection tab now uses `Cable` (line 19); settings tab uses `Settings` gear (line 21). More semantically accurate.
- AppShell.stories.tsx covers all 5 tab active states — complete Storybook coverage.

**Remaining gap:**

Active tab indicator — background fill vs. 3px underline. UI-SPEC.md TabNavigation state table is explicit: active state uses `transparent` background and a 3px centered `--color-accent-interactive` underline. The implementation at `TabNavigation.tsx` lines 58–61 applies `backgroundColor: "var(--color-bg-elevated)"` as the active signal. This is a pill/capsule fill — a heavier visual signal than designed. The icon/label also use `--color-accent-interactive` for the active color, but spec says active icon should be `--color-text-primary` with the underline as the sole accent element.

Logo container missing. UI-SPEC.md Layout Architecture specifies a 28×28 rounded container (`--radius-md`, `--color-bg-elevated`) around the Shield icon. `TitleBar.tsx` renders the Shield directly without a container element. Minor visual gap.

Tab bar is positioned at the bottom of the app (after all content panels, `App.tsx` line 442), confirmed by `borderTop` in `TabNavigation.tsx` line 38. Spec describes top placement below title bar. This appears to be an intentional evolution during implementation — bottom nav is reasonable for compact windows. Not scored down as a defect, noted as a documented divergence.

---

### Pillar 3: Color (4/4)

Full token compliance confirmed across all Phase 4 components.

`ServerSidebar.tsx`: All hardcoded Tailwind status classes (`bg-emerald-400`, `bg-amber-400`, `bg-neutral-500`, `bg-red-400`, `hover:bg-red-500/20`, `text-red-400`, `text-amber-400`) replaced with `var(--color-status-*)` inline styles. Grep confirms zero remaining matches for those class names in any `.tsx`.

`WindowControls.tsx`: Uses `var(--color-bg-hover)`, `var(--color-destructive)`, `var(--color-text-inverse)`, `var(--color-text-secondary)`. No hardcoded RGBA or hex values in the component.

`index.css` line 40: `.window-control-close:hover { color: #fff !important }` — acceptable. The `#fff` is a Windows HIG platform exception explicitly documented in UI-SPEC.md "Close button hover exception" section.

`StepProgress.tsx`: Uses `var(--color-status-connected)`, `var(--color-accent-interactive)`, `var(--color-status-error)`, `var(--color-text-muted)`, `var(--color-border)` — all semantic tokens. Primitive token bypass was resolved per the objective.

`TitleBar.tsx`: `var(--color-accent-interactive)`, `var(--color-bg-elevated)`, `var(--color-text-primary)`.
`TabNavigation.tsx`: `var(--color-bg-hover)`, `var(--color-bg-elevated)`, `var(--color-accent-interactive)`, `var(--color-text-secondary)`, `var(--color-border)`.

No arbitrary `text-[#...]` or `bg-[#...]` found in layout components. Dead CSS from previous audit (`btn-primary` gradient, `status-dot-*` classes) confirmed removed.

Accent restraint: `--color-accent-interactive` appears on Shield icon, PRO badge, and active tab element — appropriate, within the 3 reserved uses.

---

### Pillar 4: Typography (3/4)

**Token scale:** `--font-size-xs: 11px`, `--font-size-sm: 12px`, `--font-size-md: 14px`. `--font-weight-normal: 400`, `--font-weight-semibold: 600`.

**Spec vs. implementation for TitleBar:**
- App name: spec 14px/600 (`--font-size-md`/`--font-weight-semibold`). Implementation `text-[12px] font-medium` at `TitleBar.tsx` line 29 — 12px/500, arbitrary class, below spec size.
- PRO badge: spec 11px (`--font-size-xs`). Implementation `text-[9px]` at `TitleBar.tsx` line 39 — 9px, sub-token-scale, arbitrary class.

**Tab labels:** `TabNavigation.tsx` line 67 — `fontSize: 10, fontWeight: active ? 600 : 400`. 10px is below token scale minimum (11px). Weight logic is correct (600 active / 400 inactive) matching spec, but values are raw integers not token refs.

**ServerSidebar:** Section header `fontSize: "11px"` (line 39) — equals `--font-size-xs`, not referenced via var. Server sub-label `text-[10px]` (line 71) — arbitrary. `text-xs` (12px Tailwind) on server name (line 71) — equivalent to `--font-size-sm` but not via token.

**What passes:** Weight distribution is consistently 400/600 matching token values. Letter-spacing `-0.01em` (TitleBar brand) and `0.02em` (sidebar header) match `--tracking-tight` / `--tracking-wide` intent. No sizes above the scale in use.

---

### Pillar 5: Spacing (3/4)

**Matches spec:**
- Title bar height: `style={{ height: 32 }}` at `TitleBar.tsx` line 18 — correct.
- ServerSidebar width: `w-[200px]` — matches spec's 200px layout dimension.
- ServerSidebar header height: `h-[40px]` — matches spec.
- Token-via-Tailwind spacing (`px-3` = 12px = `--space-3`, `gap-1.5` = 6px, `p-2` = 8px = `--space-2`) — consistent.

**Divergences:**

Tab bar height: `style={{ height: 56 }}` at `TabNavigation.tsx` line 37 — spec requires 40px. 16px over. The stories JSDoc explicitly documents "56px height", confirming intentional evolution. 56px accommodates icon+label stacking better, but it is a spec deviation.

WindowControls buttons: `index.css` lines 26–27 — `width: 30px; height: 26px`. Spec requires 40px wide × 32px tall (full title bar height). Both dimensions are smaller than spec. The 40px width is specifically noted in UI-SPEC.md as a Windows HIG minimum for the close button touch target.

TitleBar brand spacing: `gap-1.5` (6px) and `pl-3` (12px) at `TitleBar.tsx` line 21. Spec specifies `gap-[--space-2]` (8px) and `pl-[--space-4]` (16px). 2–4px off spec, using Tailwind fractional values instead of token vars.

PRO badge padding: `px-1.5` (6px) at `TitleBar.tsx` line 39. Spec: `px-[--space-2]` (8px).

Tab hover pill: `width: 120, height: 44` inline at `TabNavigation.tsx` lines 56–57. Spec declares 40px tab height; 44px is close but the width is an unconstrained magic number bypassing the layout system.

---

### Pillar 6: Experience Design (3/4)

**Improvements confirmed since previous audit:**
- StepProgress uses semantic color tokens throughout — primitive token bypass resolved.
- EmptyState in Connection tab has `className="flex-1"` (`App.tsx` line 394) — vertically centered. Confirmed fix.

**What passes:**
- Empty states: `EmptyState` in ServerSidebar and Connection tab — correct icon, heading, body.
- Error boundaries: `PanelErrorBoundary` wraps all 4 content panels at `App.tsx` lines 357, 376, 402. Full error coverage.
- Connecting state: `animate-pulse` dot + `Loader2 animate-spin` in ServerSidebar — visual feedback present.
- Keyboard shortcuts: `useKeyboardShortcuts` maps Ctrl+1..5 to 5 tabs.
- Destructive pattern: close button `--color-destructive` on hover; disconnect Power icon uses `--color-status-error`.

**Remaining gaps:**

`hasConfig` prop absent from TabNavigation. UI-SPEC.md State Matrix requires connection/routing/settings to render at 40% opacity with `aria-disabled="true"` and blocked clicks when `hasConfig = false`. The component interface at `TabNavigation.tsx` lines 6–9 has only `{ activeTab, onTabChange }`. Users without config can click Routing and encounter a RoutingPanel that receives an empty configPath string.

Arrow-key keyboard navigation absent. UI-SPEC.md Accessibility Contract: "Arrow keys move between tabs." `TabNavigation.tsx` has no `onKeyDown` handler. WAI-ARIA tab widget spec requires `ArrowLeft`/`ArrowRight` to move focus between tabs in a `role="tablist"` container. Standard Tab/Enter keyboard flow works but does not satisfy the ARIA authoring pattern.

`data-tauri-drag-region` on `<span>` text node (`TitleBar.tsx` line 34). Spec notes the attribute should be on containers, not interactive or text elements. Functionally harmless but semantically misplaced.

---

## Registry Safety

No shadcn/ui (`components.json` not present). UI-SPEC.md Registry Safety table: "None — no shadcn, no third-party registries." Audit skipped — not applicable.

---

## Files Audited

| File | Purpose |
|------|---------|
| `gui-app/src/components/layout/TitleBar.tsx` | Title bar component |
| `gui-app/src/components/layout/TabNavigation.tsx` | 5-tab bottom navigation |
| `gui-app/src/components/layout/TabNavigation.test.tsx` | TabNavigation test coverage |
| `gui-app/src/components/layout/WindowControls.tsx` | Window control buttons |
| `gui-app/src/components/layout/AppShell.stories.tsx` | Composite shell stories |
| `gui-app/src/components/ServerSidebar.tsx` | Server list sidebar |
| `gui-app/src/App.tsx` | Application shell integration |
| `gui-app/src/components/layout/TitleBar.stories.tsx` | TitleBar Storybook stories |
| `gui-app/src/components/layout/TabNavigation.stories.tsx` | TabNavigation Storybook stories |
| `gui-app/src/components/layout/WindowControls.stories.tsx` | WindowControls Storybook stories |
| `gui-app/src/components/ServerSidebar.stories.tsx` | ServerSidebar Storybook stories |
| `gui-app/src/components/server/StepProgress.tsx` | Step progress indicator |
| `gui-app/src/shared/ui/EmptyState.tsx` | Empty state shared component |
| `gui-app/src/shared/i18n/locales/ru.json` | Russian i18n strings |
| `gui-app/src/index.css` | Global CSS (window-control-btn class) |
| `.planning/phases/04-mtproto-proxy/04-UI-SPEC.md` | Design contract (audit baseline) |
